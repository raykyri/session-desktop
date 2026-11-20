/** Both desktop and web execute this format contract. */
export const sessionWidgetFixtures = [
  {
    name: "complete",
    markdown: '```session-html title="Growth"\n<p>1</p>\n```',
    states: ["complete"],
    titles: ["Growth"],
  },
  {
    name: "streaming",
    markdown: "```session-html\n<p>unfinished",
    states: ["partial"],
    titles: [undefined],
  },
  {
    name: "nested",
    markdown: "> ```session-html\n> <p>1</p>\n> ```",
    states: ["complete"],
    titles: [undefined],
  },
  {
    name: "list-leading",
    markdown: "- ```session-html\n  <p>1</p>\n  ```",
    states: ["complete"],
    titles: [undefined],
  },
  {
    name: "quoted-title",
    markdown: '```session-html title="A \\"quoted\\" chart"\n<p>1</p>\n```',
    states: ["complete"],
    titles: ['A "quoted" chart'],
  },
  {
    name: "indented-sample",
    markdown: "    ```session-html\n    <p>1</p>\n    ```",
    states: [],
    titles: [],
  },
  {
    name: "fenced-sample",
    markdown: "````markdown\n```session-html\n<p>1</p>\n```\n````",
    states: [],
    titles: [],
  },
];
