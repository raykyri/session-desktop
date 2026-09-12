use std::{
    cmp::Ordering,
    env,
    path::{Path, PathBuf},
    process::Command,
};

const MIN_SWIFT_DEPLOYMENT_TARGET: &str = "11.3";

fn main() {
    println!("cargo:rerun-if-env-changed=DEVELOPER_DIR");
    println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");
    build_native_support_bridge();
    tauri_build::build();
}

fn build_native_support_bridge() {
    if env::var("CARGO_CFG_TARGET_OS").ok().as_deref() != Some("macos") {
        return;
    }

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let package_dir = manifest_dir.join("swift-native-support");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed={}", package_dir.display());

    let target_dir = env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest_dir.join("target"));
    let native_build_root = target_dir.join("native-support");
    let deployment_target = swift_deployment_target();
    let target = swift_target_triple(&deployment_target);
    let arch = target.split('-').next().unwrap_or("arm64");
    // SwiftPM keeps build-plan metadata at the scratch root. Sharing that root
    // across the two universal-build architectures can leave one architecture
    // with the other's stale source list after a Swift file is added.
    let scratch = native_build_root.join(format!("swiftpm-{arch}"));
    let cache = native_build_root.join("cache");
    let module_cache = native_build_root.join("module-cache");
    let config = native_build_root.join("config");
    let security = native_build_root.join("security");
    for dir in [&scratch, &cache, &module_cache, &config, &security] {
        std::fs::create_dir_all(dir).unwrap_or_else(|err| {
            panic!(
                "failed to create native-support build directory {}: {err}",
                dir.display()
            )
        });
    }

    let swift = xcrun_path(&["--find", "swift"])
        .or_else(|| Some(PathBuf::from("swift")))
        .expect("Swift is required to build the native support bridge");

    let mut failures = Vec::new();
    for sdk_path in native_support_sdk_candidates() {
        let output = Command::new(&swift)
            .env("SDKROOT", &sdk_path)
            .env("CLANG_MODULE_CACHE_PATH", &module_cache)
            .env("SWIFTPM_MODULECACHE_OVERRIDE", &module_cache)
            .arg("build")
            .arg("--package-path")
            .arg(&package_dir)
            .arg("--configuration")
            .arg("release")
            .arg("--triple")
            .arg(&target)
            .arg("--scratch-path")
            .arg(&scratch)
            .arg("--cache-path")
            .arg(&cache)
            .arg("--config-path")
            .arg(&config)
            .arg("--security-path")
            .arg(&security)
            .output();

        match output {
            Ok(output) if output.status.success() => {
                let products = scratch.join(format!("{arch}-apple-macosx/release"));
                let bridge = products.join("libSessionNativeSupport.a");
                if !bridge.exists() {
                    failures.push(format!(
                        "SwiftPM succeeded with SDK {} but did not produce {}",
                        sdk_path.display(),
                        bridge.display()
                    ));
                    continue;
                }

                // Fold the bridge archive's identity into the build-script
                // output: cargo only relinks the binary when this output
                // changes, so without it a rebuilt archive with byte-identical
                // link flags leaves a stale bridge inside the shipped binary.
                let bridge_stamp = fs_metadata_stamp(&bridge);
                println!("cargo:rustc-env=SESSION_NATIVE_BRIDGE_STAMP={bridge_stamp}");
                println!("cargo:rustc-link-search=native={}", products.display());
                // The AppKit/WebKit archive still needs the toolchain's Swift
                // runtime libraries after removing the separate title bridge.
                if let Some(swift_library_path) = swift_platform_library_path(&swift) {
                    println!(
                        "cargo:rustc-link-search=native={}",
                        swift_library_path.display()
                    );
                }
                // Keep the Session archive identity and load its Swift/ObjC
                // metadata alongside the exported C entry points.
                println!("cargo:rustc-link-arg=-Wl,-force_load,{}", bridge.display());
                for framework in ["AppKit", "CoreGraphics", "Foundation", "WebKit"] {
                    println!("cargo:rustc-link-lib=framework={framework}");
                }
                println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
                return;
            }
            Ok(output) => failures.push(format!(
                "SDK {} failed: stdout: {}; stderr: {}",
                sdk_path.display(),
                String::from_utf8_lossy(&output.stdout).trim(),
                String::from_utf8_lossy(&output.stderr).trim()
            )),
            Err(err) => failures.push(format!(
                "failed to start {} with SDK {}: {err}",
                swift.display(),
                sdk_path.display()
            )),
        }
    }

    panic!(
        "failed to build the native support bridge: {}",
        failures.join("; ")
    );
}

/// Size + mtime stamp of a build product, used to make the build-script output
/// (and therefore cargo's link fingerprint) track the product's content.
fn fs_metadata_stamp(path: &Path) -> String {
    match std::fs::metadata(path) {
        Ok(meta) => {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |duration| duration.as_nanos());
            format!("{}-{}", meta.len(), mtime)
        }
        Err(_) => "missing".to_string(),
    }
}

fn native_support_sdk_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(sdk) = env::var_os("SDKROOT").map(PathBuf::from)
        && sdk.exists()
    {
        candidates.push(sdk);
    }

    // Command Line Tools installations can temporarily contain a newer SDK than
    // their Swift compiler supports after an OS update. Try every versioned SDK
    // oldest-first — the caller falls back through candidates on build failure,
    // so the stable SDK is preferred and a too-new one still gets attempted —
    // then the unversioned symlink, then the active SDK selected by xcrun.
    for sdk in command_line_tools_sdks() {
        if !candidates.contains(&sdk) {
            candidates.push(sdk);
        }
    }
    let symlinked = PathBuf::from("/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk");
    if symlinked.exists() && !candidates.contains(&symlinked) {
        candidates.push(symlinked);
    }
    if let Some(sdk) = xcrun_path(&["--sdk", "macosx", "--show-sdk-path"])
        && !candidates.contains(&sdk)
    {
        candidates.push(sdk);
    }
    candidates
}

/// Versioned `MacOSX<version>.sdk` directories under the Command Line Tools
/// install, sorted oldest-first. Skips symlinks (`MacOSX.sdk`, `MacOSX15.sdk`)
/// so each real SDK appears once.
fn command_line_tools_sdks() -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir("/Library/Developer/CommandLineTools/SDKs") else {
        return Vec::new();
    };
    let mut sdks: Vec<(Vec<u32>, PathBuf)> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .file_type()
                .is_ok_and(|file_type| !file_type.is_symlink())
        })
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let version = name.strip_prefix("MacOSX")?.strip_suffix(".sdk")?;
            let version = version
                .split('.')
                .map(str::parse)
                .collect::<Result<Vec<u32>, _>>()
                .ok()?;
            Some((version, entry.path()))
        })
        .collect();
    sdks.sort();
    sdks.into_iter().map(|(_, path)| path).collect()
}

fn swift_target_triple(deployment_target: &str) -> String {
    let arch = match env::var("CARGO_CFG_TARGET_ARCH")
        .unwrap_or_default()
        .as_str()
    {
        "aarch64" => "arm64".to_string(),
        other => other.to_string(),
    };
    format!("{arch}-apple-macosx{deployment_target}")
}

fn swift_deployment_target() -> String {
    let requested = env::var("MACOSX_DEPLOYMENT_TARGET")
        .ok()
        .filter(|version| !version.trim().is_empty())
        .unwrap_or_else(|| "13.0".to_string());

    if compare_macos_versions(&requested, MIN_SWIFT_DEPLOYMENT_TARGET) == Some(Ordering::Less) {
        MIN_SWIFT_DEPLOYMENT_TARGET.to_string()
    } else {
        requested
    }
}

fn compare_macos_versions(left: &str, right: &str) -> Option<Ordering> {
    let left = parse_macos_version(left)?;
    let right = parse_macos_version(right)?;
    let length = left.len().max(right.len());

    for index in 0..length {
        let left_part = left.get(index).copied().unwrap_or_default();
        let right_part = right.get(index).copied().unwrap_or_default();
        match left_part.cmp(&right_part) {
            Ordering::Equal => {}
            ordering => return Some(ordering),
        }
    }

    Some(Ordering::Equal)
}

fn parse_macos_version(version: &str) -> Option<Vec<u32>> {
    let parts = version
        .trim()
        .split('.')
        .map(str::parse)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;

    (!parts.is_empty()).then_some(parts)
}

fn swift_platform_library_path(swift: &Path) -> Option<PathBuf> {
    let usr_dir = swift.parent()?.parent()?;
    let library_path = usr_dir.join("lib/swift/macosx");
    library_path.exists().then_some(library_path)
}

fn xcrun_path(args: &[&str]) -> Option<PathBuf> {
    let output = Command::new("xcrun").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!path.is_empty()).then(|| PathBuf::from(path))
}
