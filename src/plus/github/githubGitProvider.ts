/* eslint-disable @typescript-eslint/require-await */
import {
	authentication,
	AuthenticationSession,
	Disposable,
	Event,
	EventEmitter,
	FileType,
	Range,
	TextDocument,
	Uri,
	window,
	workspace,
	WorkspaceFolder,
} from 'vscode';
import { encodeUtf8Hex } from '@env/hex';
import { configuration } from '../../configuration';
import { CharCode, ContextKeys, Schemes } from '../../constants';
import type { Container } from '../../container';
import { setContext } from '../../context';
import {
	AuthenticationError,
	AuthenticationErrorReason,
	ExtensionNotFoundError,
	OpenVirtualRepositoryError,
	OpenVirtualRepositoryErrorReason,
} from '../../errors';
import { Features } from '../../features';
import {
	GitProvider,
	GitProviderId,
	NextComparisonUrisResult,
	PagedResult,
	PreviousComparisonUrisResult,
	PreviousLineComparisonUrisResult,
	RepositoryCloseEvent,
	RepositoryOpenEvent,
	RepositoryVisibility,
	ScmRepository,
} from '../../git/gitProvider';
import { GitUri } from '../../git/gitUri';
import {
	BranchSortOptions,
	GitBlame,
	GitBlameAuthor,
	GitBlameLine,
	GitBlameLines,
	GitBranch,
	GitBranchReference,
	GitCommit,
	GitCommitIdentity,
	GitCommitLine,
	GitContributor,
	GitDiff,
	GitDiffFilter,
	GitDiffHunkLine,
	GitDiffShortStat,
	GitFile,
	GitFileChange,
	GitFileIndexStatus,
	GitLog,
	GitMergeStatus,
	GitRebaseStatus,
	GitReference,
	GitReflog,
	GitRemote,
	GitRemoteType,
	GitRevision,
	GitStash,
	GitStatus,
	GitStatusFile,
	GitTag,
	GitTreeEntry,
	GitUser,
	isUserMatch,
	Repository,
	RepositoryChangeEvent,
	TagSortOptions,
} from '../../git/models';
import { RemoteProviderFactory, RemoteProviders } from '../../git/remotes/factory';
import { RemoteProvider, RichRemoteProvider } from '../../git/remotes/provider';
import { SearchPattern } from '../../git/search';
import { LogCorrelationContext, Logger } from '../../logger';
import { gate } from '../../system/decorators/gate';
import { debug, log } from '../../system/decorators/log';
import { filterMap, some } from '../../system/iterable';
import { isAbsolute, isFolderGlob, maybeUri, normalizePath, relative } from '../../system/path';
import { CachedBlame, CachedLog, GitDocumentState } from '../../trackers/gitDocumentTracker';
import { TrackedDocument } from '../../trackers/trackedDocument';
import { getRemoteHubApi, GitHubAuthorityMetadata, Metadata, RemoteHubApi } from '../remotehub';
import { fromCommitFileStatus, GitHubApi } from './github';

const emptyPagedResult: PagedResult<any> = Object.freeze({ values: [] });
const emptyPromise: Promise<GitBlame | GitDiff | GitLog | undefined> = Promise.resolve(undefined);

const githubAuthenticationScopes = ['repo', 'read:user', 'user:email'];

// Since negative lookbehind isn't supported in all browsers, this leaves out the negative lookbehind condition `(?<!\.lock)` to ensure the branch name doesn't end with `.lock`
const validBranchOrTagRegex = /^[^/](?!.*\/\.)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[^\000-\037\177 ~^:?*[\\]+[^./]$/;

interface RepositoryInfo {
	user?: GitUser | null;
}

export class GitHubGitProvider implements GitProvider, Disposable {
	descriptor = { id: GitProviderId.GitHub, name: 'GitHub' };
	readonly supportedSchemes: Set<string> = new Set([Schemes.Virtual, Schemes.GitHub, Schemes.PRs]);

	private _onDidChangeRepository = new EventEmitter<RepositoryChangeEvent>();
	get onDidChangeRepository(): Event<RepositoryChangeEvent> {
		return this._onDidChangeRepository.event;
	}

	private _onDidCloseRepository = new EventEmitter<RepositoryCloseEvent>();
	get onDidCloseRepository(): Event<RepositoryCloseEvent> {
		return this._onDidCloseRepository.event;
	}

	private _onDidOpenRepository = new EventEmitter<RepositoryOpenEvent>();
	get onDidOpenRepository(): Event<RepositoryOpenEvent> {
		return this._onDidOpenRepository.event;
	}

	private readonly _branchesCache = new Map<string, Promise<PagedResult<GitBranch>>>();
	private readonly _repoInfoCache = new Map<string, RepositoryInfo>();
	private readonly _tagsCache = new Map<string, Promise<PagedResult<GitTag>>>();

	private readonly _disposables: Disposable[] = [];

	constructor(private readonly container: Container) {}

	dispose() {
		this._disposables.forEach(d => d.dispose());
	}

	private onRepositoryChanged(repo: Repository, e: RepositoryChangeEvent) {
		// if (e.changed(RepositoryChange.Config, RepositoryChangeComparisonMode.Any)) {
		// 	this._repoInfoCache.delete(repo.path);
		// }

		// if (e.changed(RepositoryChange.Heads, RepositoryChange.Remotes, RepositoryChangeComparisonMode.Any)) {
		// 	this._branchesCache.delete(repo.path);
		// }

		this._branchesCache.delete(repo.path);
		this._tagsCache.delete(repo.path);
		this._repoInfoCache.delete(repo.path);

		this._onDidChangeRepository.fire(e);
	}

	async discoverRepositories(uri: Uri): Promise<Repository[]> {
		if (!this.supportedSchemes.has(uri.scheme)) return [];

		try {
			const { remotehub } = await this.ensureRepositoryContext(uri.toString(), true);
			const workspaceUri = remotehub.getVirtualWorkspaceUri(uri);
			if (workspaceUri == null) return [];

			return this.openRepository(undefined, workspaceUri, true);
		} catch {
			return [];
		}
	}

	updateContext(): void {
		void setContext(ContextKeys.HasVirtualFolders, this.container.git.hasOpenRepositories(this.descriptor.id));
	}

	openRepository(
		folder: WorkspaceFolder | undefined,
		uri: Uri,
		root: boolean,
		suspended?: boolean,
		closed?: boolean,
	): Repository[] {
		return [
			new Repository(
				this.container,
				this.onRepositoryChanged.bind(this),
				this.descriptor,
				folder,
				uri,
				root,
				suspended ?? !window.state.focused,
				closed,
			),
		];
	}

	// private _supportedFeatures = new Map<Features, boolean>();
	async supports(feature: Features): Promise<boolean> {
		// const supported = this._supportedFeatures.get(feature);
		// if (supported != null) return supported;

		switch (feature) {
			case Features.Worktrees:
				return false;
			default:
				return true;
		}
	}

	async visibility(repoPath: string): Promise<RepositoryVisibility> {
		const remotes = await this.getRemotes(repoPath);
		if (remotes.length === 0) return RepositoryVisibility.Local;

		const origin = remotes.find(r => r.name === 'origin');
		if (origin != null) {
			return this.getRemoteVisibility(origin);
		}

		return RepositoryVisibility.Private;
	}

	private async getRemoteVisibility(
		remote: GitRemote<RemoteProvider | RichRemoteProvider | undefined>,
	): Promise<RepositoryVisibility> {
		switch (remote.provider?.id) {
			case 'github': {
				const { github, metadata, session } = await this.ensureRepositoryContext(remote.repoPath);
				const visibility = await github.getRepositoryVisibility(
					session.accessToken,
					metadata.repo.owner,
					metadata.repo.name,
				);

				return visibility ?? RepositoryVisibility.Private;
			}
			default:
				return RepositoryVisibility.Private;
		}
	}

	async getOpenScmRepositories(): Promise<ScmRepository[]> {
		return [];
	}

	async getOrOpenScmRepository(_repoPath: string): Promise<ScmRepository | undefined> {
		return undefined;
	}

	canHandlePathOrUri(scheme: string, pathOrUri: string | Uri): string | undefined {
		if (!this.supportedSchemes.has(scheme)) return undefined;
		return typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.toString();
	}

	getAbsoluteUri(pathOrUri: string | Uri, base: string | Uri): Uri {
		// Convert the base to a Uri if it isn't one
		if (typeof base === 'string') {
			// If it looks like a Uri parse it, otherwise throw
			if (maybeUri(base)) {
				base = Uri.parse(base, true);
			} else {
				debugger;
				void window.showErrorMessage(
					`Unable to get absolute uri between ${
						typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.toString(false)
					} and ${base}; Base path '${base}' must be a uri`,
				);
				throw new Error(`Base path '${base}' must be a uri`);
			}
		}

		if (typeof pathOrUri === 'string' && !maybeUri(pathOrUri) && !isAbsolute(pathOrUri)) {
			return Uri.joinPath(base, normalizePath(pathOrUri));
		}

		const relativePath = this.getRelativePath(pathOrUri, base);
		return Uri.joinPath(base, relativePath);
	}

	@log()
	async getBestRevisionUri(repoPath: string, path: string, ref: string | undefined): Promise<Uri | undefined> {
		return ref ? this.createProviderUri(repoPath, ref, path) : this.createVirtualUri(repoPath, ref, path);
	}

	getRelativePath(pathOrUri: string | Uri, base: string | Uri): string {
		// Convert the base to a Uri if it isn't one
		if (typeof base === 'string') {
			// If it looks like a Uri parse it, otherwise throw
			if (maybeUri(base)) {
				base = Uri.parse(base, true);
			} else {
				debugger;
				void window.showErrorMessage(
					`Unable to get relative path between ${
						typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.toString(false)
					} and ${base}; Base path '${base}' must be a uri`,
				);
				throw new Error(`Base path '${base}' must be a uri`);
			}
		}

		let relativePath;

		// Convert the path to a Uri if it isn't one
		if (typeof pathOrUri === 'string') {
			if (maybeUri(pathOrUri)) {
				pathOrUri = Uri.parse(pathOrUri, true);
			} else {
				pathOrUri = normalizePath(pathOrUri);
				relativePath =
					isAbsolute(pathOrUri) && pathOrUri.startsWith(base.path)
						? pathOrUri.slice(base.path.length)
						: pathOrUri;
				if (relativePath.charCodeAt(0) === CharCode.Slash) {
					relativePath = relativePath.slice(1);
				}
				return relativePath;
			}
		}

		relativePath = normalizePath(relative(base.path.slice(1), pathOrUri.path.slice(1)));
		return relativePath;
	}

	getRevisionUri(repoPath: string, path: string, ref: string): Uri {
		const uri = this.createProviderUri(repoPath, ref, path);
		return ref === GitRevision.deletedOrMissing ? uri.with({ query: '~' }) : uri;
	}

	@log()
	async getWorkingUri(repoPath: string, uri: Uri) {
		return this.createVirtualUri(repoPath, undefined, uri.path);
	}

	@log()
	async addRemote(_repoPath: string, _name: string, _url: string): Promise<void> {}

	@log()
	async pruneRemote(_repoPath: string, _remoteName: string): Promise<void> {}

	@log()
	async applyChangesToWorkingFile(_uri: GitUri, _ref1?: string, _ref2?: string): Promise<void> {}

	@log()
	async branchContainsCommit(_repoPath: string, _name: string, _ref: string): Promise<boolean> {
		return false;
	}

	@log()
	async checkout(
		_repoPath: string,
		_ref: string,
		_options?: { createBranch?: string } | { path?: string },
	): Promise<void> {}

	@log()
	resetCaches(
		...affects: ('branches' | 'contributors' | 'providers' | 'remotes' | 'stashes' | 'status' | 'tags')[]
	): void {
		if (affects.length === 0 || affects.includes('branches')) {
			this._branchesCache.clear();
		}

		if (affects.length === 0 || affects.includes('tags')) {
			this._tagsCache.clear();
		}

		if (affects.length === 0) {
			this._repoInfoCache.clear();
		}
	}

	@log<GitHubGitProvider['excludeIgnoredUris']>({ args: { 1: uris => uris.length } })
	async excludeIgnoredUris(_repoPath: string, uris: Uri[]): Promise<Uri[]> {
		return uris;
	}

	// @gate()
	@log()
	async fetch(
		_repoPath: string,
		_options?: { all?: boolean; branch?: GitBranchReference; prune?: boolean; pull?: boolean; remote?: string },
	): Promise<void> {}

	@gate()
	@debug()
	async findRepositoryUri(uri: Uri, _isDirectory?: boolean): Promise<Uri | undefined> {
		const cc = Logger.getCorrelationContext();

		try {
			const remotehub = await this.ensureRemoteHubApi();
			const rootUri = remotehub.getProviderRootUri(uri).with({ scheme: Schemes.Virtual });
			return rootUri;
		} catch (ex) {
			if (!(ex instanceof ExtensionNotFoundError)) {
				debugger;
			}
			Logger.error(ex, cc);

			return undefined;
		}
	}

	@log<GitHubGitProvider['getAheadBehindCommitCount']>({ args: { 1: refs => refs.join(',') } })
	async getAheadBehindCommitCount(
		_repoPath: string,
		_refs: string[],
	): Promise<{ ahead: number; behind: number } | undefined> {
		return undefined;
	}

	@gate()
	@log()
	async getBlame(uri: GitUri, document?: TextDocument | undefined): Promise<GitBlame | undefined> {
		const cc = Logger.getCorrelationContext();

		// TODO@eamodio we need to figure out when to do this, since dirty isn't enough, we need to know if there are any uncommitted changes
		if (document?.isDirty) return undefined; //this.getBlameContents(uri, document.getText());

		let key = 'blame';
		if (uri.sha != null) {
			key += `:${uri.sha}`;
		}

		const doc = await this.container.tracker.getOrAdd(uri);
		if (doc.state != null) {
			const cachedBlame = doc.state.getBlame(key);
			if (cachedBlame != null) {
				Logger.debug(cc, `Cache hit: '${key}'`);
				return cachedBlame.item;
			}
		}

		Logger.debug(cc, `Cache miss: '${key}'`);

		if (doc.state == null) {
			doc.state = new GitDocumentState(doc.key);
		}

		const promise = this.getBlameCore(uri, doc, key, cc);

		if (doc.state != null) {
			Logger.debug(cc, `Cache add: '${key}'`);

			const value: CachedBlame = {
				item: promise as Promise<GitBlame>,
			};
			doc.state.setBlame(key, value);
		}

		return promise;
	}

	private async getBlameCore(
		uri: GitUri,
		document: TrackedDocument<GitDocumentState>,
		key: string,
		cc: LogCorrelationContext | undefined,
	): Promise<GitBlame | undefined> {
		try {
			const context = await this.ensureRepositoryContext(uri.repoPath!);
			if (context == null) return undefined;
			const { metadata, github, remotehub, session } = context;

			const root = remotehub.getVirtualUri(remotehub.getProviderRootUri(uri));
			const relativePath = this.getRelativePath(uri, root);

			if (uri.scheme === Schemes.Virtual) {
				const [working, committed] = await Promise.allSettled([
					workspace.fs.stat(uri),
					workspace.fs.stat(uri.with({ scheme: Schemes.GitHub })),
				]);
				if (
					working.status !== 'fulfilled' ||
					committed.status !== 'fulfilled' ||
					working.value.mtime !== committed.value.mtime
				) {
					return undefined;
				}
			}

			const ref = !uri.sha || uri.sha === 'HEAD' ? (await metadata.getRevision()).revision : uri.sha;
			const blame = await github.getBlame(
				session.accessToken,
				metadata.repo.owner,
				metadata.repo.name,
				ref,
				relativePath,
			);

			const authors = new Map<string, GitBlameAuthor>();
			const commits = new Map<string, GitCommit>();
			const lines: GitCommitLine[] = [];

			for (const range of blame.ranges) {
				const c = range.commit;

				const { viewer = session.account.label } = blame;
				const authorName = viewer != null && c.author.name === viewer ? 'You' : c.author.name;
				const committerName = viewer != null && c.committer.name === viewer ? 'You' : c.committer.name;

				let author = authors.get(authorName);
				if (author == null) {
					author = {
						name: authorName,
						lineCount: 0,
					};
					authors.set(authorName, author);
				}

				author.lineCount += range.endingLine - range.startingLine + 1;

				let commit = commits.get(c.oid);
				if (commit == null) {
					commit = new GitCommit(
						this.container,
						uri.repoPath!,
						c.oid,
						new GitCommitIdentity(authorName, c.author.email, new Date(c.author.date), c.author.avatarUrl),
						new GitCommitIdentity(committerName, c.committer.email, new Date(c.author.date)),
						c.message.split('\n', 1)[0],
						c.parents.nodes[0]?.oid ? [c.parents.nodes[0]?.oid] : [],
						c.message,
						new GitFileChange(root.toString(), relativePath, GitFileIndexStatus.Modified),
						{ changedFiles: c.changedFiles ?? 0, additions: c.additions ?? 0, deletions: c.deletions ?? 0 },
						[],
					);

					commits.set(c.oid, commit);
				}

				for (let i = range.startingLine; i <= range.endingLine; i++) {
					// GitHub doesn't currently support returning the original line number, so we are just using the current one
					const line: GitCommitLine = { sha: c.oid, originalLine: i, line: i };

					commit.lines.push(line);
					lines[i - 1] = line;
				}
			}

			const sortedAuthors = new Map([...authors.entries()].sort((a, b) => b[1].lineCount - a[1].lineCount));

			return {
				repoPath: uri.repoPath!,
				authors: sortedAuthors,
				commits: commits,
				lines: lines,
			};
		} catch (ex) {
			debugger;
			// Trap and cache expected blame errors
			if (document.state != null && !/No provider registered with/.test(String(ex))) {
				const msg = ex?.toString() ?? '';
				Logger.debug(cc, `Cache replace (with empty promise): '${key}'`);

				const value: CachedBlame = {
					item: emptyPromise as Promise<GitBlame>,
					errorMessage: msg,
				};
				document.state.setBlame(key, value);

				document.setBlameFailure();

				return emptyPromise as Promise<GitBlame>;
			}

			return undefined;
		}
	}

	@log<GitHubGitProvider['getBlameContents']>({ args: { 1: '<contents>' } })
	async getBlameContents(_uri: GitUri, _contents: string): Promise<GitBlame | undefined> {
		// TODO@eamodio figure out how to actually generate a blame given the contents (need to generate a diff)
		return undefined; //this.getBlame(uri);
	}

	@gate()
	@log()
	async getBlameForLine(
		uri: GitUri,
		editorLine: number, // 0-based, Git is 1-based
		document?: TextDocument | undefined,
		options?: { forceSingleLine?: boolean },
	): Promise<GitBlameLine | undefined> {
		const cc = Logger.getCorrelationContext();

		// TODO@eamodio we need to figure out when to do this, since dirty isn't enough, we need to know if there are any uncommitted changes
		if (document?.isDirty) return undefined; //this.getBlameForLineContents(uri, editorLine, document.getText(), options);

		if (!options?.forceSingleLine) {
			const blame = await this.getBlame(uri);
			if (blame == null) return undefined;

			let blameLine = blame.lines[editorLine];
			if (blameLine == null) {
				if (blame.lines.length !== editorLine) return undefined;
				blameLine = blame.lines[editorLine - 1];
			}

			const commit = blame.commits.get(blameLine.sha);
			if (commit == null) return undefined;

			const author = blame.authors.get(commit.author.name)!;
			return {
				author: { ...author, lineCount: commit.lines.length },
				commit: commit,
				line: blameLine,
			};
		}

		try {
			const context = await this.ensureRepositoryContext(uri.repoPath!);
			if (context == null) return undefined;
			const { metadata, github, remotehub, session } = context;

			const root = remotehub.getVirtualUri(remotehub.getProviderRootUri(uri));
			const relativePath = this.getRelativePath(uri, root);

			const ref = !uri.sha || uri.sha === 'HEAD' ? (await metadata.getRevision()).revision : uri.sha;
			const blame = await github.getBlame(
				session.accessToken,
				metadata.repo.owner,
				metadata.repo.name,
				ref,
				relativePath,
			);

			const startingLine = editorLine + 1;
			const range = blame.ranges.find(r => r.startingLine === startingLine);
			if (range == null) return undefined;

			const c = range.commit;

			const { viewer = session.account.label } = blame;
			const authorName = viewer != null && c.author.name === viewer ? 'You' : c.author.name;
			const committerName = viewer != null && c.committer.name === viewer ? 'You' : c.committer.name;

			const commit = new GitCommit(
				this.container,
				uri.repoPath!,
				c.oid,
				new GitCommitIdentity(authorName, c.author.email, new Date(c.author.date), c.author.avatarUrl),
				new GitCommitIdentity(committerName, c.committer.email, new Date(c.author.date)),
				c.message.split('\n', 1)[0],
				c.parents.nodes[0]?.oid ? [c.parents.nodes[0]?.oid] : [],
				c.message,
				new GitFileChange(root.toString(), relativePath, GitFileIndexStatus.Modified),
				{ changedFiles: c.changedFiles ?? 0, additions: c.additions ?? 0, deletions: c.deletions ?? 0 },
				[],
			);

			for (let i = range.startingLine; i <= range.endingLine; i++) {
				// GitHub doesn't currently support returning the original line number, so we are just using the current one
				const line: GitCommitLine = { sha: c.oid, originalLine: i, line: i };

				commit.lines.push(line);
			}

			return {
				author: {
					name: authorName,
					lineCount: range.endingLine - range.startingLine + 1,
				},
				commit: commit,
				// GitHub doesn't currently support returning the original line number, so we are just using the current one
				line: { sha: c.oid, originalLine: range.startingLine, line: range.startingLine },
			};
		} catch (ex) {
			debugger;
			Logger.error(cc, ex);
			return undefined;
		}
	}

	@log<GitHubGitProvider['getBlameForLineContents']>({ args: { 2: '<contents>' } })
	async getBlameForLineContents(
		_uri: GitUri,
		_editorLine: number, // 0-based, Git is 1-based
		_contents: string,
		_options?: { forceSingleLine?: boolean },
	): Promise<GitBlameLine | undefined> {
		// TODO@eamodio figure out how to actually generate a blame given the contents (need to generate a diff)
		return undefined; //this.getBlameForLine(uri, editorLine);
	}

	@log()
	async getBlameForRange(uri: GitUri, range: Range): Promise<GitBlameLines | undefined> {
		const blame = await this.getBlame(uri);
		if (blame == null) return undefined;

		return this.getBlameRange(blame, uri, range);
	}

	@log<GitHubGitProvider['getBlameForRangeContents']>({ args: { 2: '<contents>' } })
	async getBlameForRangeContents(uri: GitUri, range: Range, contents: string): Promise<GitBlameLines | undefined> {
		const blame = await this.getBlameContents(uri, contents);
		if (blame == null) return undefined;

		return this.getBlameRange(blame, uri, range);
	}

	@log<GitHubGitProvider['getBlameRange']>({ args: { 0: '<blame>' } })
	getBlameRange(blame: GitBlame, uri: GitUri, range: Range): GitBlameLines | undefined {
		if (blame.lines.length === 0) return { allLines: blame.lines, ...blame };

		if (range.start.line === 0 && range.end.line === blame.lines.length - 1) {
			return { allLines: blame.lines, ...blame };
		}

		const lines = blame.lines.slice(range.start.line, range.end.line + 1);
		const shas = new Set(lines.map(l => l.sha));

		// ranges are 0-based
		const startLine = range.start.line + 1;
		const endLine = range.end.line + 1;

		const authors = new Map<string, GitBlameAuthor>();
		const commits = new Map<string, GitCommit>();
		for (const c of blame.commits.values()) {
			if (!shas.has(c.sha)) continue;

			const commit = c.with({
				lines: c.lines.filter(l => l.line >= startLine && l.line <= endLine),
			});
			commits.set(c.sha, commit);

			let author = authors.get(commit.author.name);
			if (author == null) {
				author = {
					name: commit.author.name,
					lineCount: 0,
				};
				authors.set(author.name, author);
			}

			author.lineCount += commit.lines.length;
		}

		const sortedAuthors = new Map([...authors.entries()].sort((a, b) => b[1].lineCount - a[1].lineCount));

		return {
			repoPath: uri.repoPath!,
			authors: sortedAuthors,
			commits: commits,
			lines: lines,
			allLines: blame.lines,
		};
	}

	@log()
	async getBranch(repoPath: string | undefined): Promise<GitBranch | undefined> {
		const {
			values: [branch],
		} = await this.getBranches(repoPath, { filter: b => b.current });
		return branch;
	}

	@log({ args: { 1: false } })
	async getBranches(
		repoPath: string | undefined,
		options?: {
			cursor?: string;
			filter?: (b: GitBranch) => boolean;
			sort?: boolean | BranchSortOptions;
		},
	): Promise<PagedResult<GitBranch>> {
		if (repoPath == null) return emptyPagedResult;

		const cc = Logger.getCorrelationContext();

		let branchesPromise = options?.cursor ? undefined : this._branchesCache.get(repoPath);
		if (branchesPromise == null) {
			async function load(this: GitHubGitProvider): Promise<PagedResult<GitBranch>> {
				try {
					const { metadata, github, session } = await this.ensureRepositoryContext(repoPath!);

					const revision = await metadata.getRevision();
					const current = revision.type === 0 /* HeadType.Branch */ ? revision.name : undefined;

					const branches: GitBranch[] = [];

					let cursor = options?.cursor;
					const loadAll = cursor == null;

					while (true) {
						const result = await github.getBranches(
							session.accessToken,
							metadata.repo.owner,
							metadata.repo.name,
							{ cursor: cursor },
						);

						for (const branch of result.values) {
							const date = new Date(
								this.container.config.advanced.commitOrdering === 'author-date'
									? branch.target.authoredDate
									: branch.target.committedDate,
							);
							const ref = branch.target.oid;

							branches.push(
								new GitBranch(repoPath!, branch.name, false, branch.name === current, date, ref, {
									name: `origin/${branch.name}`,
									missing: false,
								}),
								new GitBranch(repoPath!, `origin/${branch.name}`, true, false, date, ref),
							);
						}

						if (!result.paging?.more || !loadAll) return { ...result, values: branches };

						cursor = result.paging.cursor;
					}
				} catch (ex) {
					Logger.error(ex, cc);
					debugger;

					this._branchesCache.delete(repoPath!);
					return emptyPagedResult;
				}
			}

			branchesPromise = load.call(this);
			if (options?.cursor == null) {
				this._branchesCache.set(repoPath, branchesPromise);
			}
		}

		let result = await branchesPromise;
		if (options?.filter != null) {
			result = {
				...result,
				values: result.values.filter(options.filter),
			};
		}

		if (options?.sort != null) {
			GitBranch.sort(result.values, typeof options.sort === 'boolean' ? undefined : options.sort);
		}

		return result;
	}

	@log()
	async getChangedFilesCount(repoPath: string, ref?: string): Promise<GitDiffShortStat | undefined> {
		// TODO@eamodio if there is no ref we can't return anything, until we can get at the change store from RemoteHub
		if (!ref) return undefined;

		const commit = await this.getCommit(repoPath, ref);
		if (commit?.stats == null) return undefined;

		const { stats } = commit;

		const changedFiles =
			typeof stats.changedFiles === 'number'
				? stats.changedFiles
				: stats.changedFiles.added + stats.changedFiles.changed + stats.changedFiles.deleted;
		return { additions: stats.additions, deletions: stats.deletions, changedFiles: changedFiles };
	}

	@log()
	async getCommit(repoPath: string, ref: string): Promise<GitCommit | undefined> {
		if (repoPath == null) return undefined;

		const cc = Logger.getCorrelationContext();

		try {
			const { metadata, github, session } = await this.ensureRepositoryContext(repoPath);

			const commit = await github.getCommit(session.accessToken, metadata.repo.owner, metadata.repo.name, ref);
			if (commit == null) return undefined;

			const { viewer = session.account.label } = commit;
			const authorName = viewer != null && commit.author.name === viewer ? 'You' : commit.author.name;
			const committerName = viewer != null && commit.committer.name === viewer ? 'You' : commit.committer.name;

			return new GitCommit(
				this.container,
				repoPath,
				commit.oid,
				new GitCommitIdentity(
					authorName,
					commit.author.email,
					new Date(commit.author.date),
					commit.author.avatarUrl,
				),
				new GitCommitIdentity(committerName, commit.committer.email, new Date(commit.committer.date)),
				commit.message.split('\n', 1)[0],
				commit.parents.nodes.map(p => p.oid),
				commit.message,
				commit.files?.map(
					f =>
						new GitFileChange(
							repoPath,
							f.filename ?? '',
							fromCommitFileStatus(f.status) ?? GitFileIndexStatus.Modified,
							f.previous_filename,
							undefined,
							{ additions: f.additions ?? 0, deletions: f.deletions ?? 0, changes: f.changes ?? 0 },
						),
				) ?? [],
				{
					changedFiles: commit.changedFiles ?? 0,
					additions: commit.additions ?? 0,
					deletions: commit.deletions ?? 0,
				},
				[],
			);
		} catch (ex) {
			Logger.error(ex, cc);
			debugger;
			return undefined;
		}
	}

	@log()
	async getCommitBranches(
		repoPath: string,
		ref: string,
		options?: { branch?: string; commitDate?: Date; mode?: 'contains' | 'pointsAt'; remotes?: boolean },
	): Promise<string[]> {
		if (repoPath == null || options?.commitDate == null) return [];

		const cc = Logger.getCorrelationContext();

		try {
			const { metadata, github, session } = await this.ensureRepositoryContext(repoPath);

			let branches;

			if (options?.branch) {
				branches = await github.getCommitOnBranch(
					session.accessToken,
					metadata.repo.owner,
					metadata.repo.name,
					options?.branch,
					ref,
					options?.commitDate,
				);
			} else {
				branches = await github.getCommitBranches(
					session.accessToken,
					metadata.repo.owner,
					metadata.repo.name,
					ref,
					options?.commitDate,
				);
			}

			return branches;
		} catch (ex) {
			Logger.error(ex, cc);
			debugger;
			return [];
		}
	}

	@log()
	async getCommitCount(repoPath: string, ref: string): Promise<number | undefined> {
		if (repoPath == null) return undefined;

		const cc = Logger.getCorrelationContext();

		try {
			const { metadata, github, session } = await this.ensureRepositoryContext(repoPath);

			const count = await github.getCommitCount(
				session?.accessToken,
				metadata.repo.owner,
				metadata.repo.name,
				ref,
			);

			return count;
		} catch (ex) {
			Logger.error(ex, cc);
			debugger;
			return undefined;
		}
	}

	@log()
	async getCommitForFile(
		repoPath: string | undefined,
		uri: Uri,
		options?: { ref?: string; firstIfNotFound?: boolean; range?: Range },
	): Promise<GitCommit | undefined> {
		if (repoPath == null) return undefined;

		const cc = Logger.getCorrelationContext();

		try {
			const { metadata, github, remotehub, session } = await this.ensureRepositoryContext(repoPath);

			const file = this.getRelativePath(uri, remotehub.getProviderRootUri(uri));

			const ref = !options?.ref || options.ref === 'HEAD' ? (await metadata.getRevision()).revision : options.ref;
			const commit = await github.getCommitForFile(
				session.accessToken,
				metadata.repo.owner,
				metadata.repo.name,
				ref,
				file,
			);
			if (commit == null) return undefined;

			const { viewer = session.account.label } = commit;
			const authorName = viewer != null && commit.author.name === viewer ? 'You' : commit.author.name;
			const committerName = viewer != null && commit.committer.name === viewer ? 'You' : commit.committer.name;

			const files = commit.files?.map(
				f =>
					new GitFileChange(
						repoPath,
						f.filename ?? '',
						fromCommitFileStatus(f.status) ?? GitFileIndexStatus.Modified,
						f.previous_filename,
						undefined,
						{ additions: f.additions ?? 0, deletions: f.deletions ?? 0, changes: f.changes ?? 0 },
					),
			);
			const foundFile = files?.find(f => f.path === file);

			return new GitCommit(
				this.container,
				repoPath,
				commit.oid,
				new GitCommitIdentity(
					authorName,
					commit.author.email,
					new Date(commit.author.date),
					commit.author.avatarUrl,
				),
				new GitCommitIdentity(committerName, commit.committer.email, new Date(commit.committer.date)),
				commit.message.split('\n', 1)[0],
				commit.parents.nodes.map(p => p.oid),
				commit.message,
				{ file: foundFile, files: files },
				{
					changedFiles: commit.changedFiles ?? 0,
					additions: commit.additions ?? 0,
					deletions: commit.deletions ?? 0,
				},
				[],
			);
		} catch (ex) {
			Logger.error(ex, cc);
			debugger;
			return undefined;
		}
	}

	@log()
	async getOldestUnpushedRefForFile(_repoPath: string, _uri: Uri): Promise<string | undefined> {
		// TODO@eamodio until we have access to the RemoteHub change store there isn't anything we can do here
		return undefined;
	}

	@log()
	async getContributors(
		repoPath: string,
		_options?: { all?: boolean; ref?: string; stats?: boolean },
	): Promise<GitContributor[]> {
		if (repoPath == null) return [];

		const cc = Logger.getCorrelationContext();

		try {
			const { metadata, github, session } = await this.ensureRepositoryContext(repoPath);

			const results = await github.getContributors(session.accessToken, metadata.repo.owner, metadata.repo.name);
			const currentUser = await this.getCurrentUser(repoPath);

			const contributors = [];
			for (const c of results) {
				if (c.type !== 'User') continue;

				contributors.push(
					new GitContributor(
						repoPath,
						c.name,
						c.email,
						c.contributions,
						undefined,
						isUserMatch(currentUser, c.name, c.email, c.login),
						undefined,
						c.login,
						c.avatar_url,
						c.node_id,
					),
				);
			}

			return contributors;
		} catch (ex) {
			Logger.error(ex, cc);
			debugger;
			return [];
		}
	}

	@gate()
	@log()
	async getCurrentUser(repoPath: string): Promise<GitUser | undefined> {
		if (!repoPath) return undefined;

		const cc = Logger.getCorrelationContext();

		const repo = this._repoInfoCache.get(repoPath);

		let user = repo?.user;
		if (user != null) return user;
		// If we found the repo, but no user data was found just return
		if (user === null) return undefined;

		try {
			const { metadata, github, session } = await this.ensureRepositoryContext(repoPath);
			user = await github.getCurrentUser(session.accessToken, metadata.repo.owner, metadata.repo.name);

			this._repoInfoCache.set(repoPath, { ...repo, user: user ?? null });
			return user;
		} catch (ex) {
			Logger.error(ex, cc);
			debugger;

			// Mark it so we won't bother trying again
			this._repoInfoCache.set(repoPath, { ...repo, user: null });
			return undefined;
		}
	}

	@log()
	async getDefaultBranchName(repoPath: string | undefined, _remote?: string): Promise<string | undefined> {
		if (repoPath == null) return undefined;

		const cc = Logger.getCorrelationContext();

		try {
			const { metadata, github, session } = await this.ensureRepositoryContext(repoPath);
			return await github.getDefaultBranchName(session.accessToken, metadata.repo.owner, metadata.repo.name);
		} catch (ex) {
			Logger.error(ex, cc);
			debugger;
			return undefined;
		}
	}

	@log()
	async getDiffForFile(_uri: GitUri, _ref1: string | undefined, _ref2?: string): Promise<GitDiff | undefined> {
		return undefined;
	}

	@log({
		args: {
			1: _contents => '<contents>',
		},
	})
	async getDiffForFileContents(_uri: GitUri, _ref: string, _contents: string): Promise<GitDiff | undefined> {
		return undefined;
	}

	@log()
	async getDiffForLine(
		_uri: GitUri,
		_editorLine: number, // 0-based, Git is 1-based
		_ref1: string | undefined,
		_ref2?: string,
	): Promise<GitDiffHunkLine | undefined> {
		return undefined;
	}

	@log()
	async getDiffStatus(
		_repoPath: string,
		_ref1?: string,
		_ref2?: string,
		_options?: { filters?: GitDiffFilter[]; similarityThreshold?: number },
	): Promise<GitFile[] | undefined> {
		return undefined;
	}

	@log()
	async getFileStatusForCommit(repoPath: string, uri: Uri, ref: string): Promise<GitFile | undefined> {
		if (ref === GitRevision.deletedOrMissing || GitRevision.isUncommitted(ref)) return undefined;

		const commit = await this.getCommitForFile(repoPath, uri, { ref: ref });
		if (commit == null) return undefined;

		return commit.findFile(uri);
	}

	async getLastFetchedTimestamp(_repoPath: string): Promise<number | undefined> {
		return undefined;
	}

	@log()
	async getLog(
		repoPath: string,
		options?: {
			all?: boolean;
			authors?: GitUser[];
			cursor?: string;
			limit?: number;
			merges?: boolean;
			ordering?: string | null;
			ref?: string;
			since?: string;
		},
	): Promise<GitLog | undefined> {
		if (repoPath == null) return undefined;

		const cc = Logger.getCorrelationContext();

		const limit = this.getPagingLimit(options?.limit);

		try {
			const { metadata, github, session } = await this.ensureRepositoryContext(repoPath);

			const ref = !options?.ref || options.ref === 'HEAD' ? (await metadata.getRevision()).revision : options.ref;
			const result = await github.getCommits(session.accessToken, metadata.repo.owner, metadata.repo.name, ref, {
				all: options?.all,
				authors: options?.authors,
				after: options?.cursor,
				limit: limit,
				since: options?.since ? new Date(options.since) : undefined,
			});

			const commits = new Map<string, GitCommit>();

			const { viewer = session.account.label } = result;
			for (const commit of result.values) {
				const authorName = viewer != null && commit.author.name === viewer ? 'You' : commit.author.name;
				const committerName =
					viewer != null && commit.committer.name === viewer ? 'You' : commit.committer.name;

				let c = commits.get(commit.oid);
				if (c == null) {
					c = new GitCommit(
						this.container,
						repoPath,
						commit.oid,
						new GitCommitIdentity(
							authorName,
							commit.author.email,
							new Date(commit.author.date),
							commit.author.avatarUrl,
						),
						new GitCommitIdentity(committerName, commit.committer.email, new Date(commit.committer.date)),
						commit.message.split('\n', 1)[0],
						commit.parents.nodes.map(p => p.oid),
						commit.message,
						commit.files?.map(
							f =>
								new GitFileChange(
									repoPath,
									f.filename ?? '',
									fromCommitFileStatus(f.status) ?? GitFileIndexStatus.Modified,
									f.previous_filename,
									undefined,
									{
										additions: f.additions ?? 0,
										deletions: f.deletions ?? 0,
										changes: f.changes ?? 0,
									},
								),
						),
						{
							changedFiles: commit.changedFiles ?? 0,
							additions: commit.additions ?? 0,
							deletions: commit.deletions ?? 0,
						},
						[],
					);
					commits.set(commit.oid, c);
				}
			}

			const log: GitLog = {
				repoPath: repoPath,
				commits: commits,
				sha: ref,
				range: undefined,
				count: commits.size,
				limit: limit,
				hasMore: result.paging?.more ?? false,
				cursor: result.paging?.cursor,
				query: (limit: number | undefined) => this.getLog(repoPath, { ...options, limit: limit }),
			};

			if (log.hasMore) {
				log.more = this.getLogMoreFn(log, options);
			}

			return log;
		} catch (ex) {
			Logger.error(ex, cc);
			debugger;
			return undefined;
		}
	}

	@log()
	async getLogRefsOnly(
		repoPath: string,
		options?: {
			authors?: GitUser[];
			cursor?: string;
			limit?: number;
			merges?: boolean;
			ordering?: string | null;
			ref?: string;
			since?: string;
		},
	): Promise<Set<string> | undefined> {
		// TODO@eamodio optimize this
		const result = await this.getLog(repoPath, options);
		if (result == null) return undefined;

		return new Set([...result.commits.values()].map(c => c.ref));
	}

	private getLogMoreFn(
		log: GitLog,
		options?: {
			authors?: GitUser[];
			limit?: number;
			merges?: boolean;
			ordering?: string | null;
			ref?: string;
		},
	): (limit: number | { until: string } | undefined) => Promise<GitLog> {
		return async (limit: number | { until: string } | undefined) => {
			const moreUntil = limit != null && typeof limit === 'object' ? limit.until : undefined;
			let moreLimit = typeof limit === 'number' ? limit : undefined;

			if (moreUntil && some(log.commits.values(), c => c.ref === moreUntil)) {
				return log;
			}

			moreLimit = this.getPagingLimit(moreLimit);

			// // If the log is for a range, then just get everything prior + more
			// if (GitRevision.isRange(log.sha)) {
			// 	const moreLog = await this.getLog(log.repoPath, {
			// 		...options,
			// 		limit: moreLimit === 0 ? 0 : (options?.limit ?? 0) + moreLimit,
			// 	});
			// 	// If we can't find any more, assume we have everything
			// 	if (moreLog == null) return { ...log, hasMore: false };

			// 	return moreLog;
			// }

			// const ref = Iterables.last(log.commits.values())?.ref;
			// const moreLog = await this.getLog(log.repoPath, {
			// 	...options,
			// 	limit: moreUntil == null ? moreLimit : 0,
			// 	ref: moreUntil == null ? `${ref}^` : `${moreUntil}^..${ref}^`,
			// });
			// // If we can't find any more, assume we have everything
			// if (moreLog == null) return { ...log, hasMore: false };

			const moreLog = await this.getLog(log.repoPath, {
				...options,
				limit: moreLimit,
				cursor: log.cursor,
			});
			// If we can't find any more, assume we have everything
			if (moreLog == null) return { ...log, hasMore: false };

			const commits = new Map([...log.commits, ...moreLog.commits]);

			const mergedLog: GitLog = {
				repoPath: log.repoPath,
				commits: commits,
				sha: log.sha,
				range: undefined,
				count: commits.size,
				limit: moreUntil == null ? (log.limit ?? 0) + moreLimit : undefined,
				hasMore: moreUntil == null ? moreLog.hasMore : true,
				cursor: moreLog.cursor,
				query: log.query,
			};
			mergedLog.more = this.getLogMoreFn(mergedLog, options);

			return mergedLog;
		};
	}

	@log()
	async getLogForSearch(
		repoPath: string,
		search: SearchPattern,
		options?: { cursor?: string; limit?: number; ordering?: 'date' | 'author-date' | 'topo' | null; skip?: number },
	): Promise<GitLog | undefined> {
		if (repoPath == null) return undefined;

		const cc = Logger.getCorrelationContext();

		const operations = SearchPattern.parseSearchOperations(search.pattern);

		let op;
		let values = operations.get('commit:');
		if (values != null) {
			const commit = await this.getCommit(repoPath, values[0]);
			if (commit == null) return undefined;

			return {
				repoPath: repoPath,
				commits: new Map([[commit.sha, commit]]),
				sha: commit.sha,
				range: undefined,
				count: 1,
				limit: 1,
				hasMore: false,
			};
		}

		const query = [];

		for ([op, values] of operations.entries()) {
			switch (op) {
				case 'message:':
					query.push(...values.map(m => m.replace(/ /g, '+')));
					break;

				case 'author:':
					query.push(
						...values.map(a => {
							a = a.replace(/ /g, '+');
							if (a.startsWith('@')) return `author:${a.slice(1)}`;
							if (a.startsWith('"@')) return `author:"${a.slice(2)}`;
							if (a.includes('@')) return `author-email:${a}`;
							return `author-name:${a}`;
						}),
					);
					break;

				// case 'change:':
				// case 'file:':
				// 	break;
			}
		}

		if (query.length === 0) return undefined;

		const limit = this.getPagingLimit(options?.limit);

		try {
			const { metadata, github, session } = await this.ensureRepositoryContext(repoPath);

			const result = await github.searchCommits(
				session.accessToken,
				`repo:${metadata.repo.owner}/${metadata.repo.name}+${query.join('+').trim()}`,
				{
					cursor: options?.cursor,
					limit: limit,
					sort:
						options?.ordering === 'date'
							? 'committer-date'
							: options?.ordering === 'author-date'
							? 'author-date'
							: undefined,
				},
			);
			if (result == null) return undefined;

			const commits = new Map<string, GitCommit>();

			const viewer = session.account.label;
			for (const commit of result.values) {
				const authorName = viewer != null && commit.author.name === viewer ? 'You' : commit.author.name;
				const committerName =
					viewer != null && commit.committer.name === viewer ? 'You' : commit.committer.name;

				let c = commits.get(commit.oid);
				if (c == null) {
					c = new GitCommit(
						this.container,
						repoPath,
						commit.oid,
						new GitCommitIdentity(
							authorName,
							commit.author.email,
							new Date(commit.author.date),
							commit.author.avatarUrl,
						),
						new GitCommitIdentity(committerName, commit.committer.email, new Date(commit.committer.date)),
						commit.message.split('\n', 1)[0],
						commit.parents.nodes.map(p => p.oid),
						commit.message,
						commit.files?.map(
							f =>
								new GitFileChange(
									repoPath,
									f.filename ?? '',
									fromCommitFileStatus(f.status) ?? GitFileIndexStatus.Modified,
									f.previous_filename,
									undefined,
									{
										additions: f.additions ?? 0,
										deletions: f.deletions ?? 0,
										changes: f.changes ?? 0,
									},
								),
						),
						{
							changedFiles: commit.changedFiles ?? 0,
							additions: commit.additions ?? 0,
							deletions: commit.deletions ?? 0,
						},
						[],
					);
					commits.set(commit.oid, c);
				}
			}

			const log: GitLog = {
				repoPath: repoPath,
				commits: commits,
				sha: undefined,
				range: undefined,
				count: commits.size,
				limit: limit,
				hasMore: result.pageInfo?.hasNextPage ?? false,
				cursor: result.pageInfo?.endCursor ?? undefined,
				query: (limit: number | undefined) => this.getLog(repoPath, { ...options, limit: limit }),
			};

			if (log.hasMore) {
				log.more = this.getLogForSearchMoreFn(log, search, options);
			}

			return log;
		} catch (ex) {
			Logger.error(ex, cc);
			debugger;
			return undefined;
		}

		return undefined;
	}

	private getLogForSearchMoreFn(
		log: GitLog,
		search: SearchPattern,
		options?: { limit?: number; ordering?: 'date' | 'author-date' | 'topo' | null; skip?: number },
	): (limit: number | undefined) => Promise<GitLog> {
		return async (limit: number | undefined) => {
			limit = this.getPagingLimit(limit);

			const moreLog = await this.getLogForSearch(log.repoPath, search, {
				...options,
				limit: limit,
				cursor: log.cursor,
			});
			// If we can't find any more, assume we have everything
			if (moreLog == null) return { ...log, hasMore: false };

			const commits = new Map([...log.commits, ...moreLog.commits]);

			const mergedLog: GitLog = {
				repoPath: log.repoPath,
				commits: commits,
				sha: log.sha,
				range: undefined,
				count: commits.size,
				limit: (log.limit ?? 0) + limit,
				hasMore: moreLog.hasMore,
				cursor: moreLog.cursor,
				query: log.query,
			};
			mergedLog.more = this.getLogForSearchMoreFn(mergedLog, search, options);

			return mergedLog;
		};
	}

	@log()
	async getLogForFile(
		repoPath: string | undefined,
		pathOrUri: string | Uri,
		options?: {
			all?: boolean;
			cursor?: string;
			force?: boolean | undefined;
			limit?: number;
			ordering?: string | null;
			range?: Range;
			ref?: string;
			renames?: boolean;
			reverse?: boolean;
			since?: string;
			skip?: number;
		},
	): Promise<GitLog | undefined> {
		if (repoPath == null) return undefined;

		const cc = Logger.getCorrelationContext();

		const relativePath = this.getRelativePath(pathOrUri, repoPath);

		if (repoPath != null && repoPath === relativePath) {
			throw new Error(`File name cannot match the repository path; path=${relativePath}`);
		}

		options = { reverse: false, ...options };

		// Not currently supported
		options.renames = false;
		options.all = false;

		// if (options.renames == null) {
		// 	options.renames = this.container.config.advanced.fileHistoryFollowsRenames;
		// }

		let key = 'log';
		if (options.ref != null) {
			key += `:${options.ref}`;
		}

		// if (options.all == null) {
		// 	options.all = this.container.config.advanced.fileHistoryShowAllBranches;
		// }
		// if (options.all) {
		// 	key += ':all';
		// }

		options.limit = this.getPagingLimit(options?.limit);
		if (options.limit) {
			key += `:n${options.limit}`;
		}

		if (options.renames) {
			key += ':follow';
		}

		if (options.reverse) {
			key += ':reverse';
		}

		if (options.since) {
			key += `:since=${options.since}`;
		}

		if (options.skip) {
			key += `:skip${options.skip}`;
		}

		if (options.cursor) {
			key += `:cursor=${options.cursor}`;
		}

		const doc = await this.container.tracker.getOrAdd(GitUri.fromFile(relativePath, repoPath, options.ref));
		if (!options.force && options.range == null) {
			if (doc.state != null) {
				const cachedLog = doc.state.getLog(key);
				if (cachedLog != null) {
					Logger.debug(cc, `Cache hit: '${key}'`);
					return cachedLog.item;
				}

				if (options.ref != null || options.limit != null) {
					// Since we are looking for partial log, see if we have the log of the whole file
					const cachedLog = doc.state.getLog(
						`log${options.renames ? ':follow' : ''}${options.reverse ? ':reverse' : ''}`,
					);
					if (cachedLog != null) {
						if (options.ref == null) {
							Logger.debug(cc, `Cache hit: ~'${key}'`);
							return cachedLog.item;
						}

						Logger.debug(cc, `Cache ?: '${key}'`);
						let log = await cachedLog.item;
						if (log != null && !log.hasMore && log.commits.has(options.ref)) {
							Logger.debug(cc, `Cache hit: '${key}'`);

							// Create a copy of the log starting at the requested commit
							let skip = true;
							let i = 0;
							const commits = new Map(
								filterMap<[string, GitCommit], [string, GitCommit]>(
									log.commits.entries(),
									([ref, c]) => {
										if (skip) {
											if (ref !== options?.ref) return undefined;
											skip = false;
										}

										i++;
										if (options?.limit != null && i > options.limit) {
											return undefined;
										}

										return [ref, c];
									},
								),
							);

							const opts = { ...options };
							log = {
								...log,
								limit: options.limit,
								count: commits.size,
								commits: commits,
								query: (limit: number | undefined) =>
									this.getLogForFile(repoPath, pathOrUri, { ...opts, limit: limit }),
							};

							return log;
						}
					}
				}
			}

			Logger.debug(cc, `Cache miss: '${key}'`);

			if (doc.state == null) {
				doc.state = new GitDocumentState(doc.key);
			}
		}

		const promise = this.getLogForFileCore(repoPath, relativePath, doc, key, cc, options);

		if (doc.state != null && options.range == null) {
			Logger.debug(cc, `Cache add: '${key}'`);

			const value: CachedLog = {
				item: promise as Promise<GitLog>,
			};
			doc.state.setLog(key, value);
		}

		return promise;
	}

	private async getLogForFileCore(
		repoPath: string | undefined,
		path: string,
		document: TrackedDocument<GitDocumentState>,
		key: string,
		cc: LogCorrelationContext | undefined,
		options?: {
			all?: boolean;
			cursor?: string;
			limit?: number;
			ordering?: string | null;
			range?: Range;
			ref?: string;
			renames?: boolean;
			reverse?: boolean;
			since?: string;
			skip?: number;
		},
	): Promise<GitLog | undefined> {
		if (repoPath == null) return undefined;

		const limit = this.getPagingLimit(options?.limit);

		try {
			const context = await this.ensureRepositoryContext(repoPath);
			if (context == null) return undefined;
			const { metadata, github, remotehub, session } = context;

			const uri = this.getAbsoluteUri(path, repoPath);
			const relativePath = this.getRelativePath(uri, remotehub.getProviderRootUri(uri));

			// if (range != null && range.start.line > range.end.line) {
			// 	range = new Range(range.end, range.start);
			// }

			const ref = !options?.ref || options.ref === 'HEAD' ? (await metadata.getRevision()).revision : options.ref;
			const result = await github.getCommits(session.accessToken, metadata.repo.owner, metadata.repo.name, ref, {
				all: options?.all,
				after: options?.cursor,
				path: relativePath,
				limit: limit,
				since: options?.since ? new Date(options.since) : undefined,
			});

			const commits = new Map<string, GitCommit>();

			const { viewer = session.account.label } = result;
			for (const commit of result.values) {
				const authorName = viewer != null && commit.author.name === viewer ? 'You' : commit.author.name;
				const committerName =
					viewer != null && commit.committer.name === viewer ? 'You' : commit.committer.name;

				let c = commits.get(commit.oid);
				if (c == null) {
					const files = commit.files?.map(
						f =>
							new GitFileChange(
								repoPath,
								f.filename ?? '',
								fromCommitFileStatus(f.status) ?? GitFileIndexStatus.Modified,
								f.previous_filename,
								undefined,
								{ additions: f.additions ?? 0, deletions: f.deletions ?? 0, changes: f.changes ?? 0 },
							),
					);
					const foundFile = isFolderGlob(relativePath)
						? undefined
						: files?.find(f => f.path === relativePath) ??
						  new GitFileChange(
								repoPath,
								relativePath,
								GitFileIndexStatus.Modified,
								undefined,
								undefined,
								commit.changedFiles === 1
									? { additions: commit.additions ?? 0, deletions: commit.deletions ?? 0, changes: 0 }
									: undefined,
						  );

					c = new GitCommit(
						this.container,
						repoPath,
						commit.oid,
						new GitCommitIdentity(
							authorName,
							commit.author.email,
							new Date(commit.author.date),
							commit.author.avatarUrl,
						),
						new GitCommitIdentity(committerName, commit.committer.email, new Date(commit.committer.date)),
						commit.message.split('\n', 1)[0],
						commit.parents.nodes.map(p => p.oid),
						commit.message,
						{ file: foundFile, files: files },
						{
							changedFiles: commit.changedFiles ?? 0,
							additions: commit.additions ?? 0,
							deletions: commit.deletions ?? 0,
						},
						[],
					);
					commits.set(commit.oid, c);
				}
			}

			const log: GitLog = {
				repoPath: repoPath,
				commits: commits,
				sha: ref,
				range: undefined,
				count: commits.size,
				limit: limit,
				hasMore: result.paging?.more ?? false,
				cursor: result.paging?.cursor,
				query: (limit: number | undefined) => this.getLogForFile(repoPath, path, { ...options, limit: limit }),
			};

			if (log.hasMore) {
				log.more = this.getLogForFileMoreFn(log, path, options);
			}

			return log;
		} catch (ex) {
			debugger;
			// Trap and cache expected log errors
			if (document.state != null && options?.range == null && !options?.reverse) {
				const msg: string = ex?.toString() ?? '';
				Logger.debug(cc, `Cache replace (with empty promise): '${key}'`);

				const value: CachedLog = {
					item: emptyPromise as Promise<GitLog>,
					errorMessage: msg,
				};
				document.state.setLog(key, value);

				return emptyPromise as Promise<GitLog>;
			}

			return undefined;
		}
	}

	private getLogForFileMoreFn(
		log: GitLog,
		relativePath: string,
		options?: {
			all?: boolean;
			limit?: number;
			ordering?: string | null;
			range?: Range;
			ref?: string;
			renames?: boolean;
			reverse?: boolean;
		},
	): (limit: number | { until: string } | undefined) => Promise<GitLog> {
		return async (limit: number | { until: string } | undefined) => {
			const moreUntil = limit != null && typeof limit === 'object' ? limit.until : undefined;
			let moreLimit = typeof limit === 'number' ? limit : undefined;

			if (moreUntil && some(log.commits.values(), c => c.ref === moreUntil)) {
				return log;
			}

			moreLimit = this.getPagingLimit(moreLimit);

			// const ref = Iterables.last(log.commits.values())?.ref;
			const moreLog = await this.getLogForFile(log.repoPath, relativePath, {
				...options,
				limit: moreUntil == null ? moreLimit : 0,
				cursor: log.cursor,
				// ref: options.all ? undefined : moreUntil == null ? `${ref}^` : `${moreUntil}^..${ref}^`,
				// skip: options.all ? log.count : undefined,
			});
			// If we can't find any more, assume we have everything
			if (moreLog == null) return { ...log, hasMore: false };

			const commits = new Map([...log.commits, ...moreLog.commits]);

			const mergedLog: GitLog = {
				repoPath: log.repoPath,
				commits: commits,
				sha: log.sha,
				range: log.range,
				count: commits.size,
				limit: moreUntil == null ? (log.limit ?? 0) + moreLimit : undefined,
				hasMore: moreUntil == null ? moreLog.hasMore : true,
				cursor: moreLog.cursor,
				query: log.query,
			};

			// if (options.renames) {
			// 	const renamed = find(
			// 		moreLog.commits.values(),
			// 		c => Boolean(c.file?.originalPath) && c.file?.originalPath !== fileName,
			// 	);
			// 	fileName = renamed?.file?.originalPath ?? fileName;
			// }

			mergedLog.more = this.getLogForFileMoreFn(mergedLog, relativePath, options);

			return mergedLog;
		};
	}

	@log()
	async getMergeBase(
		_repoPath: string,
		_ref1: string,
		_ref2: string,
		_options: { forkPoint?: boolean },
	): Promise<string | undefined> {
		return undefined;
	}

	// @gate()
	@log()
	async getMergeStatus(_repoPath: string): Promise<GitMergeStatus | undefined> {
		return undefined;
	}

	// @gate()
	@log()
	async getRebaseStatus(_repoPath: string): Promise<GitRebaseStatus | undefined> {
		return undefined;
	}

	@log()
	async getNextComparisonUris(
		repoPath: string,
		uri: Uri,
		ref: string | undefined,
		skip: number = 0,
	): Promise<NextComparisonUrisResult | undefined> {
		// If we have no ref there is no next commit
		if (!ref) return undefined;

		const cc = Logger.getCorrelationContext();

		try {
			const context = await this.ensureRepositoryContext(repoPath);
			if (context == null) return undefined;

			const { metadata, github, remotehub, session } = context;
			const relativePath = this.getRelativePath(uri, remotehub.getProviderRootUri(uri));
			const revision = (await metadata.getRevision()).revision;

			if (ref === 'HEAD') {
				ref = revision;
			}

			const refs = await github.getNextCommitRefs(
				session.accessToken,
				metadata.repo.owner,
				metadata.repo.name,
				revision,
				relativePath,
				ref,
			);

			return {
				current:
					skip === 0
						? GitUri.fromFile(relativePath, repoPath, ref)
						: new GitUri(await this.getBestRevisionUri(repoPath, relativePath, refs[skip - 1])),
				next: new GitUri(await this.getBestRevisionUri(repoPath, relativePath, refs[skip])),
			};
		} catch (ex) {
			Logger.error(ex, cc);
			debugger;

			throw ex;
		}
	}

	@log()
	async getPreviousComparisonUris(
		repoPath: string,
		uri: Uri,
		ref: string | undefined,
		skip: number = 0,
		_firstParent: boolean = false,
	): Promise<PreviousComparisonUrisResult | undefined> {
		if (ref === GitRevision.deletedOrMissing) return undefined;

		const cc = Logger.getCorrelationContext();

		if (ref === GitRevision.uncommitted) {
			ref = undefined;
		}

		try {
			const context = await this.ensureRepositoryContext(repoPath);
			if (context == null) return undefined;

			const { metadata, github, remotehub, session } = context;
			const relativePath = this.getRelativePath(uri, remotehub.getProviderRootUri(uri));

			const offset = ref != null ? 1 : 0;

			const result = await github.getCommitRefs(
				session.accessToken,
				metadata.repo.owner,
				metadata.repo.name,
				!ref || ref === 'HEAD' ? (await metadata.getRevision()).revision : ref,
				{
					path: relativePath,
					first: offset + skip + 1,
				},
			);
			if (result == null) return undefined;

			// If we are at a commit, diff commit with previous
			const current =
				skip === 0
					? GitUri.fromFile(relativePath, repoPath, ref)
					: new GitUri(
							await this.getBestRevisionUri(
								repoPath,
								relativePath,
								result.values[offset + skip - 1]?.oid ?? GitRevision.deletedOrMissing,
							),
					  );
			if (current == null || current.sha === GitRevision.deletedOrMissing) return undefined;

			return {
				current: current,
				previous: new GitUri(
					await this.getBestRevisionUri(
						repoPath,
						relativePath,
						result.values[offset + skip]?.oid ?? GitRevision.deletedOrMissing,
					),
				),
			};
		} catch (ex) {
			Logger.error(ex, cc);
			debugger;

			throw ex;
		}
	}

	@log()
	async getPreviousComparisonUrisForLine(
		repoPath: string,
		uri: Uri,
		editorLine: number, // 0-based, Git is 1-based
		ref: string | undefined,
		skip: number = 0,
	): Promise<PreviousLineComparisonUrisResult | undefined> {
		if (ref === GitRevision.deletedOrMissing) return undefined;

		const cc = Logger.getCorrelationContext();

		try {
			const context = await this.ensureRepositoryContext(repoPath);
			if (context == null) return undefined;

			const { remotehub } = context;

			let relativePath = this.getRelativePath(uri, remotehub.getProviderRootUri(uri));

			// FYI, GitHub doesn't currently support returning the original line number, nor the previous sha, so this is untrustworthy

			let current = GitUri.fromFile(relativePath, repoPath, ref);
			let currentLine = editorLine;
			let previous;
			let previousLine = editorLine;
			let nextLine = editorLine;

			for (let i = 0; i < Math.max(0, skip) + 2; i++) {
				const blameLine = await this.getBlameForLine(previous ?? current, nextLine, undefined, {
					forceSingleLine: true,
				});
				if (blameLine == null) break;

				// Diff with line ref with previous
				ref = blameLine.commit.sha;
				relativePath = blameLine.commit.file?.path ?? blameLine.commit.file?.originalPath ?? relativePath;
				nextLine = blameLine.line.originalLine - 1;

				const gitUri = GitUri.fromFile(relativePath, repoPath, ref);
				if (previous == null) {
					previous = gitUri;
					previousLine = nextLine;
				} else {
					current = previous;
					currentLine = previousLine;
					previous = gitUri;
					previousLine = nextLine;
				}
			}

			if (current == null) return undefined;

			return {
				current: current,
				previous: previous,
				line: (currentLine ?? editorLine) + 1, // 1-based
			};
		} catch (ex) {
			Logger.error(ex, cc);
			debugger;

			throw ex;
		}
	}

	@log()
	async getIncomingActivity(
		_repoPath: string,
		_options?: { all?: boolean; branch?: string; limit?: number; ordering?: string | null; skip?: number },
	): Promise<GitReflog | undefined> {
		return undefined;
	}

	@log({ args: { 1: false } })
	async getRemotes(
		repoPath: string | undefined,
		options?: { providers?: RemoteProviders; sort?: boolean },
	): Promise<GitRemote<RemoteProvider | RichRemoteProvider | undefined>[]> {
		if (repoPath == null) return [];

		const providers = options?.providers ?? RemoteProviderFactory.loadProviders(configuration.get('remotes', null));

		const uri = Uri.parse(repoPath, true);
		const [, owner, repo] = uri.path.split('/', 3);

		const url = `https://github.com/${owner}/${repo}.git`;
		const domain = 'github.com';
		const path = `${owner}/${repo}`;

		return [
			new GitRemote(
				repoPath,
				`${domain}/${path}`,
				'origin',
				'https',
				domain,
				path,
				RemoteProviderFactory.factory(providers)(url, domain, path),
				[
					{ type: GitRemoteType.Fetch, url: url },
					{ type: GitRemoteType.Push, url: url },
				],
			),
		];
	}

	@log()
	async getRevisionContent(repoPath: string, path: string, ref: string): Promise<Uint8Array | undefined> {
		const uri = ref ? this.createProviderUri(repoPath, ref, path) : this.createVirtualUri(repoPath, ref, path);
		return workspace.fs.readFile(uri);
	}

	// @gate()
	@log()
	async getStash(_repoPath: string | undefined): Promise<GitStash | undefined> {
		return undefined;
	}

	@log()
	async getStatusForFile(_repoPath: string, _uri: Uri): Promise<GitStatusFile | undefined> {
		return undefined;
	}

	@log()
	async getStatusForFiles(_repoPath: string, _pathOrGlob: Uri): Promise<GitStatusFile[] | undefined> {
		return undefined;
	}

	@log()
	async getStatusForRepo(_repoPath: string | undefined): Promise<GitStatus | undefined> {
		return undefined;
	}

	@log({ args: { 1: false } })
	async getTags(
		repoPath: string | undefined,
		options?: { cursor?: string; filter?: (t: GitTag) => boolean; sort?: boolean | TagSortOptions },
	): Promise<PagedResult<GitTag>> {
		if (repoPath == null) return emptyPagedResult;

		const cc = Logger.getCorrelationContext();

		let tagsPromise = options?.cursor ? undefined : this._tagsCache.get(repoPath);
		if (tagsPromise == null) {
			async function load(this: GitHubGitProvider): Promise<PagedResult<GitTag>> {
				try {
					const { metadata, github, session } = await this.ensureRepositoryContext(repoPath!);

					const tags: GitTag[] = [];

					let cursor = options?.cursor;
					const loadAll = cursor == null;

					while (true) {
						const result = await github.getTags(
							session.accessToken,
							metadata.repo.owner,
							metadata.repo.name,
							{ cursor: cursor },
						);

						for (const tag of result.values) {
							tags.push(
								new GitTag(
									repoPath!,
									tag.name,
									tag.target.oid,
									tag.target.message ?? '',
									new Date(tag.target.authoredDate ?? tag.target.tagger?.date),
									new Date(tag.target.committedDate ?? tag.target.tagger?.date),
								),
							);
						}

						if (!result.paging?.more || !loadAll) return { ...result, values: tags };

						cursor = result.paging.cursor;
					}
				} catch (ex) {
					Logger.error(ex, cc);
					debugger;

					this._tagsCache.delete(repoPath!);
					return emptyPagedResult;
				}
			}

			tagsPromise = load.call(this);
			if (options?.cursor == null) {
				this._tagsCache.set(repoPath, tagsPromise);
			}
		}

		let result = await tagsPromise;
		if (options?.filter != null) {
			result = {
				...result,
				values: result.values.filter(options.filter),
			};
		}

		if (options?.sort != null) {
			GitTag.sort(result.values, typeof options.sort === 'boolean' ? undefined : options.sort);
		}

		return result;
	}

	@log()
	async getTreeEntryForRevision(repoPath: string, path: string, ref: string): Promise<GitTreeEntry | undefined> {
		if (repoPath == null || !path) return undefined;

		if (ref === 'HEAD') {
			const context = await this.ensureRepositoryContext(repoPath);
			if (context == null) return undefined;

			const revision = await context.metadata.getRevision();
			ref = revision?.revision;
		}

		const uri = ref ? this.createProviderUri(repoPath, ref, path) : this.createVirtualUri(repoPath, ref, path);

		const stats = await workspace.fs.stat(uri);
		if (stats == null) return undefined;

		return {
			path: this.getRelativePath(uri, repoPath),
			commitSha: ref,
			size: stats.size,
			type: (stats.type & FileType.Directory) === FileType.Directory ? 'tree' : 'blob',
		};
	}

	@log()
	async getTreeForRevision(repoPath: string, ref: string): Promise<GitTreeEntry[]> {
		if (repoPath == null) return [];

		if (ref === 'HEAD') {
			const context = await this.ensureRepositoryContext(repoPath);
			if (context == null) return [];

			const revision = await context.metadata.getRevision();
			ref = revision?.revision;
		}

		const baseUri = ref ? this.createProviderUri(repoPath, ref) : this.createVirtualUri(repoPath, ref);

		const entries = await workspace.fs.readDirectory(baseUri);
		if (entries == null) return [];

		const result: GitTreeEntry[] = [];
		for (const [path, type] of entries) {
			const uri = this.getAbsoluteUri(path, baseUri);

			// TODO:@eamodio do we care about size?
			// const stats = await workspace.fs.stat(uri);

			result.push({
				path: this.getRelativePath(path, uri),
				commitSha: ref,
				size: 0, // stats?.size,
				type: (type & FileType.Directory) === FileType.Directory ? 'tree' : 'blob',
			});
		}

		// TODO@eamodio: Implement this
		return [];
	}

	@log()
	async hasBranchOrTag(
		repoPath: string | undefined,
		options?: {
			filter?: { branches?: (b: GitBranch) => boolean; tags?: (t: GitTag) => boolean };
		},
	) {
		const [{ values: branches }, { values: tags }] = await Promise.all([
			this.getBranches(repoPath, {
				filter: options?.filter?.branches,
				sort: false,
			}),
			this.getTags(repoPath, {
				filter: options?.filter?.tags,
				sort: false,
			}),
		]);

		return branches.length !== 0 || tags.length !== 0;
	}

	@log()
	async hasCommitBeenPushed(_repoPath: string, _ref: string): Promise<boolean> {
		// In this env we can't have unpushed commits
		return true;
	}

	isTrackable(uri: Uri): boolean {
		return this.supportedSchemes.has(uri.scheme);
	}

	async isTracked(uri: Uri): Promise<boolean> {
		if (!this.isTrackable(uri) || this.container.git.getRepository(uri) == null) return false;

		// Don't call out to RemoteHub to keep things more performant, since we only work with GitHub here
		// const remotehub = await this.ensureRemoteHubApi();
		// if (remotehub == null) return false;

		// const providerUri = remotehub.getProviderUri(uri);
		// if (providerUri == null) return false;

		const providerUri = uri.with({ scheme: Schemes.GitHub });
		const stats = await workspace.fs.stat(providerUri);
		return stats != null;
	}

	@log()
	async getDiffTool(_repoPath?: string): Promise<string | undefined> {
		return undefined;
	}

	@log()
	async openDiffTool(
		_repoPath: string,
		_uri: Uri,
		_options?: { ref1?: string; ref2?: string; staged?: boolean; tool?: string },
	): Promise<void> {}

	@log()
	async openDirectoryCompare(_repoPath: string, _ref1: string, _ref2?: string, _tool?: string): Promise<void> {}

	@log()
	async resolveReference(repoPath: string, ref: string, pathOrUri?: string | Uri, _options?: { timeout?: number }) {
		if (
			!ref ||
			ref === GitRevision.deletedOrMissing ||
			(pathOrUri == null && GitRevision.isSha(ref)) ||
			(pathOrUri != null && GitRevision.isUncommitted(ref))
		) {
			return ref;
		}

		let relativePath;
		if (pathOrUri != null) {
			relativePath = this.getRelativePath(pathOrUri, repoPath);
		} else if (!GitRevision.isShaLike(ref) || ref.endsWith('^3')) {
			// If it doesn't look like a sha at all (e.g. branch name) or is a stash ref (^3) don't try to resolve it
			return ref;
		}

		const context = await this.ensureRepositoryContext(repoPath);
		if (context == null) return ref;

		const { metadata, github, session } = context;

		const resolved = await github.resolveReference(
			session.accessToken,
			metadata.repo.owner,
			metadata.repo.name,
			ref,
			relativePath,
		);

		if (resolved != null) return resolved;

		return relativePath ? GitRevision.deletedOrMissing : ref;
	}

	@log()
	async validateBranchOrTagName(ref: string, _repoPath?: string): Promise<boolean> {
		return validBranchOrTagRegex.test(ref);
	}

	@log()
	async validateReference(_repoPath: string, _ref: string): Promise<boolean> {
		return true;
	}

	@log()
	async stageFile(_repoPath: string, _pathOrUri: string | Uri): Promise<void> {}

	@log()
	async stageDirectory(_repoPath: string, _directoryOrUri: string | Uri): Promise<void> {}

	@log()
	async unStageFile(_repoPath: string, _pathOrUri: string | Uri): Promise<void> {}

	@log()
	async unStageDirectory(_repoPath: string, _directoryOrUri: string | Uri): Promise<void> {}

	@log()
	async stashApply(_repoPath: string, _stashName: string, _options?: { deleteAfter?: boolean }): Promise<void> {}

	@log()
	async stashDelete(_repoPath: string, _stashName: string, _ref?: string): Promise<void> {}

	@log<GitHubGitProvider['stashSave']>({ args: { 2: uris => uris?.length } })
	async stashSave(
		_repoPath: string,
		_message?: string,
		_uris?: Uri[],
		_options?: { includeUntracked?: boolean; keepIndex?: boolean },
	): Promise<void> {}

	@gate()
	private async ensureRepositoryContext(
		repoPath: string,
		open?: boolean,
	): Promise<{ github: GitHubApi; metadata: Metadata; remotehub: RemoteHubApi; session: AuthenticationSession }> {
		let uri = Uri.parse(repoPath, true);
		if (!/^github\+?/.test(uri.authority)) {
			throw new OpenVirtualRepositoryError(repoPath, OpenVirtualRepositoryErrorReason.NotAGitHubRepository);
		}

		if (!open) {
			const repo = this.container.git.getRepository(uri);
			if (repo == null) {
				throw new OpenVirtualRepositoryError(repoPath, OpenVirtualRepositoryErrorReason.NotAGitHubRepository);
			}

			uri = repo.uri;
		}

		let remotehub = this._remotehub;
		if (remotehub == null) {
			try {
				remotehub = await this.ensureRemoteHubApi();
			} catch (ex) {
				if (!(ex instanceof ExtensionNotFoundError)) {
					debugger;
				}
				throw new OpenVirtualRepositoryError(
					repoPath,
					OpenVirtualRepositoryErrorReason.RemoteHubApiNotFound,
					ex,
				);
			}
		}

		const metadata = await remotehub?.getMetadata(uri);
		if (metadata?.provider.id !== 'github') {
			throw new OpenVirtualRepositoryError(repoPath, OpenVirtualRepositoryErrorReason.NotAGitHubRepository);
		}

		let github;
		let session;
		try {
			[github, session] = await Promise.all([this.ensureGitHub(), this.ensureSession()]);
		} catch (ex) {
			debugger;
			if (ex instanceof AuthenticationError) {
				throw new OpenVirtualRepositoryError(
					repoPath,
					ex.reason === AuthenticationErrorReason.UserDidNotConsent
						? OpenVirtualRepositoryErrorReason.GitHubAuthenticationDenied
						: OpenVirtualRepositoryErrorReason.GitHubAuthenticationNotFound,
					ex,
				);
			}

			throw new OpenVirtualRepositoryError(repoPath);
		}
		if (github == null) {
			debugger;
			throw new OpenVirtualRepositoryError(repoPath);
		}

		return { github: github, metadata: metadata, remotehub: remotehub, session: session };
	}

	private _github: GitHubApi | undefined;
	@gate()
	private async ensureGitHub() {
		if (this._github == null) {
			const github = await this.container.github;
			if (github != null) {
				this._disposables.push(
					github.onDidReauthenticate(() => {
						this._sessionPromise = undefined;
						void this.ensureSession(true);
					}),
				);
			}
			this._github = github;
		}
		return this._github;
	}

	/** Only use this if you NEED non-promise access to RemoteHub */
	private _remotehub: RemoteHubApi | undefined;
	private _remotehubPromise: Promise<RemoteHubApi> | undefined;
	private async ensureRemoteHubApi(): Promise<RemoteHubApi>;
	private async ensureRemoteHubApi(silent: false): Promise<RemoteHubApi>;
	private async ensureRemoteHubApi(silent: boolean): Promise<RemoteHubApi | undefined>;
	private async ensureRemoteHubApi(silent?: boolean): Promise<RemoteHubApi | undefined> {
		if (this._remotehubPromise == null) {
			this._remotehubPromise = getRemoteHubApi();
			// Not a fan of this, but we need to be able to access RemoteHub without a promise
			this._remotehubPromise.then(
				api => (this._remotehub = api),
				() => (this._remotehub = undefined),
			);
		}

		if (!silent) return this._remotehubPromise;

		try {
			return await this._remotehubPromise;
		} catch {
			return undefined;
		}
	}

	private _sessionPromise: Promise<AuthenticationSession> | undefined;
	private async ensureSession(force: boolean = false): Promise<AuthenticationSession> {
		if (this._sessionPromise == null) {
			async function getSession(): Promise<AuthenticationSession> {
				try {
					if (force) {
						return await authentication.getSession('github', githubAuthenticationScopes, {
							forceNewSession: true,
						});
					}

					return await authentication.getSession('github', githubAuthenticationScopes, {
						createIfNone: true,
					});
				} catch (ex) {
					if (ex instanceof Error && ex.message.includes('User did not consent')) {
						throw new AuthenticationError('github', AuthenticationErrorReason.UserDidNotConsent);
					}

					Logger.error(ex);
					debugger;
					throw new AuthenticationError('github', undefined, ex);
				}
			}

			this._sessionPromise = getSession();
		}

		return this._sessionPromise;
	}

	private createVirtualUri(base: string | Uri, ref?: GitReference | string, path?: string): Uri {
		let metadata: GitHubAuthorityMetadata | undefined;

		if (typeof ref === 'string') {
			if (ref) {
				if (GitRevision.isSha(ref)) {
					metadata = { v: 1, ref: { id: ref, type: 2 /* RepositoryRefType.Commit */ } };
				} else {
					metadata = { v: 1, ref: { id: ref, type: 4 /* RepositoryRefType.Tree */ } };
				}
			}
		} else {
			switch (ref?.refType) {
				case 'revision':
				case 'stash':
					metadata = { v: 1, ref: { id: ref.ref, type: 2 /* RepositoryRefType.Commit */ } };
					break;
				case 'branch':
				case 'tag':
					metadata = { v: 1, ref: { id: ref.name, type: 4 /* RepositoryRefType.Tree */ } };
					break;
			}
		}

		if (typeof base === 'string') {
			base = Uri.parse(base, true);
		}

		if (path) {
			let basePath = base.path;
			if (basePath.endsWith('/')) {
				basePath = basePath.slice(0, -1);
			}

			path = this.getRelativePath(path, base);
			path = `${basePath}/${path.startsWith('/') ? path.slice(0, -1) : path}`;
		}

		return base.with({
			scheme: Schemes.Virtual,
			authority: encodeAuthority<GitHubAuthorityMetadata>('github', metadata),
			path: path ?? base.path,
		});
	}

	private createProviderUri(base: string | Uri, ref?: GitReference | string, path?: string): Uri {
		const uri = this.createVirtualUri(base, ref, path);
		if (this._remotehub == null) {
			debugger;
			return uri.scheme !== Schemes.Virtual ? uri : uri.with({ scheme: Schemes.GitHub });
		}

		return this._remotehub.getProviderUri(uri);
	}

	private getPagingLimit(limit?: number): number {
		limit = Math.min(100, limit ?? this.container.config.advanced.maxListItems ?? 100);
		if (limit === 0) {
			limit = 100;
		}
		return limit;
	}

	private async resolveReferenceCore(
		repoPath: string,
		metadata: Metadata,
		ref?: string,
	): Promise<string | undefined> {
		if (ref == null || ref === 'HEAD') {
			const revision = await metadata.getRevision();
			return revision.revision;
		}

		if (GitRevision.isSha(ref)) return ref;

		// TODO@eamodio need to handle ranges
		if (GitRevision.isRange(ref)) return undefined;

		const [branchResults, tagResults] = await Promise.allSettled([
			this.getBranches(repoPath, { filter: b => b.name === ref }),
			this.getTags(repoPath, { filter: t => t.name === ref }),
		]);

		ref =
			(branchResults.status === 'fulfilled' ? branchResults.value.values[0]?.sha : undefined) ??
			(tagResults.status === 'fulfilled' ? tagResults.value.values[0]?.sha : undefined);
		if (ref == null) debugger;

		return ref;
	}
}

function encodeAuthority<T>(scheme: string, metadata?: T): string {
	return `${scheme}${metadata != null ? `+${encodeUtf8Hex(JSON.stringify(metadata))}` : ''}`;
}
