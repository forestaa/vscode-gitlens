import { TextDocument, TextDocumentShowOptions, TextEditor, Uri, ViewColumn, window, workspace } from 'vscode';
import { configuration } from '../configuration';
import { CoreCommands, ImageMimetypes, Schemes } from '../constants';
import { GitUri } from '../git/gitUri';
import { Logger } from '../logger';
import { executeCoreCommand } from './command';
import { extname } from './path';

export function findEditor(uri: Uri): TextEditor | undefined {
	const active = window.activeTextEditor;
	const normalizedUri = uri.toString();

	for (const e of [...(active != null ? [active] : []), ...window.visibleTextEditors]) {
		// Don't include diff editors
		if (e.document.uri.toString() === normalizedUri && e?.viewColumn != null) {
			return e;
		}
	}

	return undefined;
}

export async function findOrOpenEditor(
	uri: Uri,
	options?: TextDocumentShowOptions & { throwOnError?: boolean },
): Promise<TextEditor | undefined> {
	const e = findEditor(uri);
	if (e != null) {
		if (!options?.preserveFocus) {
			await window.showTextDocument(e.document, { ...options, viewColumn: e.viewColumn });
		}

		return e;
	}

	return openEditor(uri, { viewColumn: window.activeTextEditor?.viewColumn, ...options });
}

export function findOrOpenEditors(uris: Uri[]): void {
	const normalizedUris = new Map(uris.map(uri => [uri.toString(), uri]));

	for (const e of window.visibleTextEditors) {
		// Don't include diff editors
		if (e?.viewColumn != null) {
			normalizedUris.delete(e.document.uri.toString());
		}
	}

	for (const uri of normalizedUris.values()) {
		void executeCoreCommand(CoreCommands.Open, uri, { background: true, preview: false });
	}
}

export function getEditorIfActive(document: TextDocument): TextEditor | undefined {
	const editor = window.activeTextEditor;
	return editor != null && editor.document === document ? editor : undefined;
}

export function getQuickPickIgnoreFocusOut() {
	return !configuration.get('advanced.quickPick.closeOnFocusOut');
}

export function hasVisibleTextEditor(): boolean {
	if (window.visibleTextEditors.length === 0) return false;

	return window.visibleTextEditors.some(e => isTextEditor(e));
}

export function isActiveDocument(document: TextDocument): boolean {
	const editor = window.activeTextEditor;
	return editor != null && editor.document === document;
}

export function isVirtualUri(uri: Uri): boolean {
	return uri.scheme === Schemes.Virtual || uri.scheme === Schemes.GitHub;
}

export function isVisibleDocument(document: TextDocument): boolean {
	if (window.visibleTextEditors.length === 0) return false;

	return window.visibleTextEditors.some(e => e.document === document);
}

export function isTextEditor(editor: TextEditor): boolean {
	const scheme = editor.document.uri.scheme;
	return scheme !== Schemes.Output && scheme !== Schemes.DebugConsole;
}

export async function openEditor(
	uri: Uri,
	options: TextDocumentShowOptions & { rethrow?: boolean } = {},
): Promise<TextEditor | undefined> {
	const { rethrow, ...opts } = options;
	try {
		if (GitUri.is(uri)) {
			uri = uri.documentUri();
		}

		if (uri.scheme === Schemes.GitLens && ImageMimetypes[extname(uri.fsPath)]) {
			await executeCoreCommand(CoreCommands.Open, uri);

			return undefined;
		}

		const document = await workspace.openTextDocument(uri);
		return window.showTextDocument(document, {
			preserveFocus: false,
			preview: true,
			viewColumn: ViewColumn.Active,
			...opts,
		});
	} catch (ex) {
		const msg: string = ex?.toString() ?? '';
		if (msg.includes('File seems to be binary and cannot be opened as text')) {
			await executeCoreCommand(CoreCommands.Open, uri);

			return undefined;
		}

		if (rethrow) throw ex;

		Logger.error(ex, 'openEditor');
		return undefined;
	}
}

export async function openWalkthrough(
	extensionId: string,
	walkthroughId: string,
	stepId?: string,
	openToSide: boolean = true,
): Promise<void> {
	// Takes the following params: walkthroughID: string | { category: string, step: string } | undefined, toSide: boolean | undefined
	void (await executeCoreCommand(
		CoreCommands.OpenWalkthrough,
		{
			category: `${extensionId}#${walkthroughId}`,
			step: stepId ? `${extensionId}#${walkthroughId}#${stepId}` : undefined,
		},
		openToSide,
	));
}

export const enum OpenWorkspaceLocation {
	CurrentWindow = 'currentWindow',
	NewWindow = 'newWindow',
	AddToWorkspace = 'addToWorkspace',
}

export function openWorkspace(
	uri: Uri,
	options: { location?: OpenWorkspaceLocation; name?: string } = { location: OpenWorkspaceLocation.CurrentWindow },
): void {
	if (options?.location === OpenWorkspaceLocation.AddToWorkspace) {
		const count = workspace.workspaceFolders?.length ?? 0;
		return void workspace.updateWorkspaceFolders(count, 0, { uri: uri, name: options?.name });
	}

	return void executeCoreCommand(CoreCommands.OpenFolder, uri, {
		forceNewWindow: options?.location === OpenWorkspaceLocation.NewWindow,
	});
}
