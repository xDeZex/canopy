// Consumed Monaco 0.45.0 contracts, not complete Monaco classes. The official
// declaration verification is recorded in docs/typescript-migration.md. DOM is opaque
// only at CDN IO: public mounting owners require native or structural nodes.
export interface Disposable { dispose(): void }
export type ZoneId = string;
export interface ViewZone {
  afterLineNumber: number; ordinal?: number; afterColumn?: number;
  domNode: unknown; heightInPx: number; suppressMouseDown?: boolean; showInHiddenAreas?: boolean;
  onDomNodeTop?(top: number): void;
}
export interface ZoneAccessor {
  addZone(zone: ViewZone): ZoneId; removeZone(id: ZoneId): void; layoutZone(id: ZoneId): void;
}
export interface Decoration {
  range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
  options: { isWholeLine?: boolean; linesDecorationsClassName?: string; glyphMarginClassName?: string; glyphMarginHoverMessage?: { value: string } };
}
export interface Position { lineNumber: number; column: number }
export interface Selection { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }
export interface TextModel extends Disposable { getLineCount(): number; getLineMaxColumn(line: number): number }
export interface LineChange {
  originalStartLineNumber: number; originalEndLineNumber: number;
  modifiedStartLineNumber: number; modifiedEndLineNumber: number;
}
export type MouseTargetType = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;
export interface MouseEvent { target: { type: MouseTargetType; position: Position | null } }
export interface CodeEditor {
  dispose(): void;
  getModel(): TextModel | null;
  getPosition(): Position | null;
  getSelection(): Selection | null;
  setPosition(position: Position): void; focus(): void;
  getScrollTop(): number; setScrollTop(top: number): void;
  getTopForLineNumber(line: number, includeViewZones?: boolean): number;
  getTopForPosition(line: number, column: number): number;
  getOption(option: 66): number;
  getLayoutInfo(): { height: number; horizontalScrollbarHeight: number };
  render(): void; revealLineInCenter(line: number): void;
  deltaDecorations(ids: string[], decorations: Decoration[]): string[];
  updateOptions(options: { folding?: boolean; glyphMargin?: boolean }): void;
  changeViewZones(callback: (accessor: ZoneAccessor) => void): void;
  onMouseMove(callback: (event: MouseEvent) => void): Disposable;
  onMouseLeave(callback: () => void): Disposable;
  onMouseDown(callback: (event: MouseEvent) => void): Disposable;
}
export interface DiffEditor extends Disposable {
  setModel(models: { original: TextModel; modified: TextModel }): void;
  getLineChanges(): LineChange[] | null;
  getOriginalEditor(): CodeEditor;
  getModifiedEditor(): CodeEditor;
  onDidUpdateDiff(callback: () => void): Disposable;
}
export interface MountSettings {
  automaticLayout: boolean; readOnly: boolean; domReadOnly: boolean; theme: string;
  value?: string; language?: string; wordWrap?: 'off' | 'on' | 'wordWrapColumn' | 'bounded'; originalEditable?: boolean; diffWordWrap?: 'off' | 'on' | 'inherit';
  experimental?: { showMoves: boolean }; renderSideBySide?: boolean; hideUnchangedRegions?: { enabled: boolean };
}
export interface MonacoRuntime {
  editor: {
    create(container: unknown, settings: MountSettings): CodeEditor;
    createDiffEditor(container: unknown, settings: MountSettings): DiffEditor;
    createModel(content: string, language?: string): TextModel;
    EditorOption: { lineHeight: 66 };
    MouseTargetType: { GUTTER_GLYPH_MARGIN: 2; GUTTER_LINE_NUMBERS: 3 };
  };
}
// A separate capability boundary permits deliberately partial IO fakes. It is
// not evidence that a partial fake implements the full consumed runtime API.
export type DiffEditorPort = Partial<Omit<DiffEditor, 'getOriginalEditor' | 'getModifiedEditor'>> & {
  getOriginalEditor?(): Partial<CodeEditor>; getModifiedEditor?(): Partial<CodeEditor>;
};
export interface MonacoPort {
  editor: Partial<Omit<MonacoRuntime['editor'], 'create' | 'createDiffEditor'>> & {
    create?(container: unknown, settings: MountSettings): Partial<CodeEditor>;
    createDiffEditor?(container: unknown, settings: MountSettings): DiffEditorPort;
  };
}
export interface AmdLoader {
  (modules: string[], loaded: () => void, failed: (error: unknown) => void): void;
  config(options: { paths: { vs: string } }): void;
}
export interface LoaderWindow { monaco?: unknown; require?: AmdLoader }
declare global {
  var monaco: MonacoPort;
  interface Window extends LoaderWindow {}
}

export function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Required Monaco capability is unavailable');
  return value;
}

// Partial IO fakes never claim a complete editor. Unsupported capabilities
// fail only when exercised, rather than silently succeeding as no-op stubs.
export function codeEditor(port: Partial<CodeEditor>): CodeEditor {
  const missing = () => { throw new Error('Required Monaco editor capability is unavailable'); };
  return {
    dispose: port.dispose?.bind(port) ?? missing,
    getModel: port.getModel?.bind(port) ?? missing,
    getPosition: port.getPosition?.bind(port) ?? missing,
    getSelection: port.getSelection?.bind(port) ?? missing,
    setPosition: port.setPosition?.bind(port) ?? missing,
    focus: port.focus?.bind(port) ?? missing,
    getScrollTop: port.getScrollTop?.bind(port) ?? missing,
    setScrollTop: port.setScrollTop?.bind(port) ?? missing,
    getTopForLineNumber: port.getTopForLineNumber?.bind(port) ?? missing,
    getTopForPosition: port.getTopForPosition?.bind(port) ?? missing,
    getOption: port.getOption?.bind(port) ?? missing,
    getLayoutInfo: port.getLayoutInfo?.bind(port) ?? missing,
    render: port.render?.bind(port) ?? missing,
    revealLineInCenter: port.revealLineInCenter?.bind(port) ?? missing,
    deltaDecorations: port.deltaDecorations?.bind(port) ?? missing,
    updateOptions: port.updateOptions?.bind(port) ?? missing,
    changeViewZones: port.changeViewZones?.bind(port) ?? missing,
    onMouseMove: port.onMouseMove?.bind(port) ?? missing,
    onMouseLeave: port.onMouseLeave?.bind(port) ?? missing,
    onMouseDown: port.onMouseDown?.bind(port) ?? missing,
  };
}
