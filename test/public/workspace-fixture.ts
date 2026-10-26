import { Element } from './fake-dom.js';

const workspaceIds = [
  'tabs-wrapper', 'tabs', 'body', 'rail', 'rail-divider', 'toolbar', 'main', 'shortcut-help',
  'code-rail', 'code-main', 'code-toolbar', 'issues-rail', 'issues-main', 'issues-toolbar', 'workspace-toggle',
] as const;

type WorkspaceNodes = Record<(typeof workspaceIds)[number], Element>;

export function createWorkspaceFixture() {
  const nodes = Object.fromEntries(workspaceIds.map((id) => [id, new Element('div')])) as WorkspaceNodes;
  const documentBody = new Element('body');
  const app = new Element('div');
  const workspaceContent = new Element('div');

  documentBody.isRoot = true;
  nodes['shortcut-help'].hidden = true;
  documentBody.append(app, nodes['shortcut-help']);
  nodes['tabs-wrapper'].append(nodes.tabs);
  app.append(nodes['tabs-wrapper'], nodes.body);
  nodes.body.append(nodes.rail, nodes['rail-divider'], workspaceContent);
  workspaceContent.append(nodes.toolbar, nodes.main);
  nodes.rail.append(nodes['code-rail'], nodes['issues-rail']);
  nodes.main.append(nodes['code-main'], nodes['issues-main']);
  nodes.toolbar.append(nodes['workspace-toggle'], nodes['code-toolbar'], nodes['issues-toolbar']);

  nodes.body.clientWidth = 1006;
  nodes['rail-divider'].offsetWidth = 6;

  const codePane = {
    rail: nodes['code-rail'],
    main: nodes['code-main'],
    toolbar: nodes['code-toolbar'],
  };
  // These aliases keep existing Code-pane assertions concise; ID lookup always
  // uses the canonical nodes above, just as the browser does.
  const elements = { ...nodes, ...codePane, outerRail: nodes.rail };
  const getElementById = (id: string) => Object.hasOwn(nodes, id) ? nodes[id as keyof WorkspaceNodes] : null;

  return { nodes, elements, codePane, containers: { documentBody, app, workspaceContent }, getElementById };
}
