//! The device's sign-in in the macOS Keychain: one generic password item
//! (service: the app's identifier; account: `device`), whose text is the
//! JSON the page keeps there (`web/desktop/src/platform.ts`). The page never
//! sees another item.

#[cfg(test)]
use std::sync::Mutex;

/// Where the item is kept: the Keychain in the app, memory in the tests.
pub trait Store: Send + Sync {
    fn get(&self) -> Result<Option<String>, String>;
    fn set(&self, value: &str) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

/// The Keychain's generic password item for (service, account).
pub struct System {
    service: String,
    account: String,
}

impl Store for System {
    fn get(&self) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(&self.service, &self.account).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
    fn set(&self, value: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(&self.service, &self.account).map_err(|e| e.to_string())?;
        entry.set_password(value).map_err(|e| e.to_string())
    }
    fn delete(&self) -> Result<(), String> {
        let entry = keyring::Entry::new(&self.service, &self.account).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// An item in memory (the tests).
#[cfg(test)]
#[derive(Default)]
pub struct Memory(Mutex<Option<String>>);

#[cfg(test)]
impl Store for Memory {
    fn get(&self) -> Result<Option<String>, String> {
        Ok(self.0.lock().map_err(|e| e.to_string())?.clone())
    }
    fn set(&self, value: &str) -> Result<(), String> {
        *self.0.lock().map_err(|e| e.to_string())? = Some(value.to_owned());
        Ok(())
    }
    fn delete(&self) -> Result<(), String> {
        *self.0.lock().map_err(|e| e.to_string())? = None;
        Ok(())
    }
}

/// The app's state for the commands.
pub struct Keychain(Box<dyn Store>);

/// The largest item the page may keep (the token, ids and the account as
/// last read are far smaller).
pub const MAX_ITEM_BYTES: usize = 64 * 1024;

impl Keychain {
    pub fn system(service: &str) -> Self {
        Self(Box::new(System {
            service: service.to_owned(),
            account: "device".to_owned(),
        }))
    }
    #[cfg(test)]
    pub fn new(store: Box<dyn Store>) -> Self {
        Self(store)
    }
    pub fn get(&self) -> Result<Option<String>, String> {
        self.0.get()
    }
    pub fn set(&self, value: &str) -> Result<(), String> {
        if value.len() > MAX_ITEM_BYTES {
            return Err(format!(
                "the Keychain item is larger than {MAX_ITEM_BYTES} bytes"
            ));
        }
        self.0.set(value)
    }
    pub fn delete(&self) -> Result<(), String> {
        self.0.delete()
    }
}

#[tauri::command]
pub fn keychain_get(keychain: tauri::State<'_, Keychain>) -> Result<Option<String>, String> {
    keychain.get()
}

#[tauri::command]
pub fn keychain_set(keychain: tauri::State<'_, Keychain>, value: String) -> Result<(), String> {
    keychain.set(&value)
}

#[tauri::command]
pub fn keychain_delete(keychain: tauri::State<'_, Keychain>) -> Result<(), String> {
    keychain.delete()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_item_is_kept_replaced_and_deleted() {
        let k = Keychain::new(Box::new(Memory::default()));
        assert_eq!(k.get().unwrap(), None);
        k.set(r#"{"token":"a"}"#).unwrap();
        assert_eq!(k.get().unwrap().as_deref(), Some(r#"{"token":"a"}"#));
        k.set(r#"{"token":"b"}"#).unwrap();
        assert_eq!(k.get().unwrap().as_deref(), Some(r#"{"token":"b"}"#));
        k.delete().unwrap();
        assert_eq!(k.get().unwrap(), None);
        // deleting nothing is not an error
        k.delete().unwrap();
    }

    #[test]
    fn an_item_over_the_limit_is_refused() {
        let k = Keychain::new(Box::new(Memory::default()));
        assert!(k.set(&"x".repeat(MAX_ITEM_BYTES + 1)).is_err());
        assert_eq!(k.get().unwrap(), None);
    }
}
