import test from "ava";
import remarkParse from "remark-parse";
import { unified } from "unified";

import {
  remarkSessionWidgetFences,
  sessionWidgetMetadata,
  type WidgetMarkdownNode,
} from "../src/markdown/sessionWidgets.js";

import { sessionWidgetFixtures } from "./sessionWidgetFixtures.js";

for (const fixture of sessionWidgetFixtures)
  test(`widget contract: ${fixture.name}`, (t) => {
    const tree = unified().use(remarkParse).parse(fixture.markdown);
    remarkSessionWidgetFences()(tree, { value: fixture.markdown });
    const states: unknown[] = [];
    const titles: unknown[] = [];
    const visit = (node: WidgetMarkdownNode) => {
      const properties = node.data?.hProperties;
      if (properties?.["dataSessionWidget"]) {
        states.push(properties["dataSessionWidget"]);
        titles.push(sessionWidgetMetadata(String(properties["dataSessionWidgetMeta"])).title);
      }
      node.children?.forEach(visit);
    };
    visit(tree);
    t.deepEqual(states, fixture.states);
    t.deepEqual(titles, fixture.titles);
  });
