const COMPOSER_TEXTAREA_MAX_HEIGHT = 200;

export function growComposerTextarea(textarea: HTMLTextAreaElement) {
  textarea.style.height = "auto";
  // The composer uses border-box sizing, but scrollHeight excludes borders.
  // Include them so even an empty, single-line field has no scroll overflow.
  const styles = getComputedStyle(textarea);
  const borderHeight = parseFloat(styles.borderTopWidth) + parseFloat(styles.borderBottomWidth);
  textarea.style.height = `${Math.min(Math.ceil(textarea.scrollHeight + borderHeight), COMPOSER_TEXTAREA_MAX_HEIGHT)}px`;
}
