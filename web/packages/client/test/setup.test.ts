import test from "ava";

test("browser storage globals use the document's stores", (t) => {
  t.is(localStorage, window.localStorage);
  t.is(sessionStorage, window.sessionStorage);
  localStorage.setItem("setup-probe", "saved");
  t.is(window.localStorage.getItem("setup-probe"), "saved");
  localStorage.removeItem("setup-probe");
});

test("DOM listeners accept the global abort controller", (t) => {
  const controller = new AbortController();
  let received = 0;
  window.addEventListener("setup-probe", () => received++, { signal: controller.signal });
  window.dispatchEvent(new Event("setup-probe"));
  controller.abort();
  window.dispatchEvent(new Event("setup-probe"));
  t.is(received, 1);
});
