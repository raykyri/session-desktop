# Layout: Miller by paragraph

Mock: `docs/mockups/canvas-layout-miller-paragraph.html`. A column browser that navigates by paragraph.

## Layout rules

- Columns are 380px wide and never narrow; the row of columns scrolls horizontally.
- Column 0 lists threads by channel. Every other column holds one stack, or the branches at one anchor.
- An anchor is a paragraph of an answer, a person's part, or a whole answer. Anchors with branches show a count
  and a chevron on their right edge. A whole answer gets a "From the whole answer" row below its paragraphs only
  when something branches from it.
- Choosing an anchor opens the next column: the branch, if there is one; otherwise a list (author, first line,
  counts). Choosing from the list replaces it with that stack.
- Each column's chosen row stays tinted: stronger in the active column, lighter in the others.
- Each step of the path bar (channel › thread › branch › …) focuses its column.

## Navigation

- **Keyboard.** Up and Down move between rows, skipping headings. Right or Enter opens the row's branches and
  moves into them. Left goes back: from a picked branch to its list, otherwise to the previous column's chosen
  row. Shift+F10 opens the part menu on the row.
- **Mouse wheel.** It scrolls the column under the pointer; over the gaps or the path bar it scrolls sideways.
  Opening a column scrolls it into view.
- **Touch, below 560px.** One column at a time. The path bar becomes a back button, naming what it returns to,
  and a title. Tapping an anchor with branches moves forward; a long press opens the part menu.

There is no 2D panning. Zoom, Fit, double-click to create, dragging and collapse are removed.

## What the user no longer manages

Placement and overlap of stacks, zoom, finding their place again, and collapsing.

## What is lost

- An overview of a thread and all its branches at once; only the current trail is visible.
- Spatial memory: nothing has a fixed position.
- Two unrelated threads side by side.

## Branching from a paragraph

The paragraph shows its branch count. Once chosen, it is tinted with an accent bar, and a connector runs from its
right edge to the next column, whose header quotes it under "From paragraph". The connector is dashed while the
paragraph is scrolled out of view. A new branch from the part menu opens in the next column with the composer.

## Open questions

1. Should Up and Down open each row's branches as they pass, as in Finder? The right-hand columns would change on
   every keystroke.
2. Answers are not clamped, since each paragraph is a row. Are long answers readable at 380px?
3. A deep trail scrolls the thread off the left edge. Should earlier columns shrink to their chosen row?
