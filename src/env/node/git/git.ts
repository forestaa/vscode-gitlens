import { Uri, window, workspace } from 'vscode';
import { hrtime } from '@env/hrtime';
import { GlyphChars } from '../../../constants';
import { GitCommandOptions, GitErrorHandling } from '../../../git/commandOptions';
import { GitDiffFilter, GitRevision, GitUser } from '../../../git/models';
import { GitBranchParser, GitLogParser, GitReflogParser, GitTagParser } from '../../../git/parsers';
import { Logger } from '../../../logger';
import { dirname, isAbsolute, isFolderGlob, joinPaths, normalizePath, splitPath } from '../../../system/path';
import { getDurationMilliseconds } from '../../../system/string';
import { compare, fromString } from '../../../system/version';
import { GitLocation } from './locator';
import { fsExists, run, RunError, RunOptions } from './shell';

const emptyArray = Object.freeze([]) as unknown as any[];
const emptyObj = Object.freeze({});

export const maxGitCliLength = 30000;

const textDecoder = new TextDecoder('utf8');

// This is a root sha of all git repo's if using sha1
const rootSha = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export const GitErrors = {
	badRevision: /bad revision '(.*?)'/i,
	noFastForward: /\(non-fast-forward\)/i,
	noMergeBase: /no merge base/i,
	notAValidObjectName: /Not a valid object name/i,
	invalidLineCount: /file .+? has only \d+ lines/i,
	uncommittedChanges: /contains modified or untracked files/i,
	alreadyExists: /already exists/i,
	alreadyCheckedOut: /already checked out/i,
	mainWorkingTree: /is a main working tree/i,
};

const GitWarnings = {
	notARepository: /Not a git repository/i,
	outsideRepository: /is outside repository/i,
	noPath: /no such path/i,
	noCommits: /does not have any commits/i,
	notFound: /Path '.*?' does not exist in/i,
	foundButNotInRevision: /Path '.*?' exists on disk, but not in/i,
	headNotABranch: /HEAD does not point to a branch/i,
	noUpstream: /no upstream configured for branch '(.*?)'/i,
	unknownRevision:
		/ambiguous argument '.*?': unknown revision or path not in the working tree|not stored as a remote-tracking branch/i,
	mustRunInWorkTree: /this operation must be run in a work tree/i,
	patchWithConflicts: /Applied patch to '.*?' with conflicts/i,
	noRemoteRepositorySpecified: /No remote repository specified\./i,
	remoteConnectionError: /Could not read from remote repository/i,
	notAGitCommand: /'.+' is not a git command/i,
};

function defaultExceptionHandler(ex: Error, cwd: string | undefined, start?: [number, number]): string {
	const msg = ex.message || ex.toString();
	if (msg != null && msg.length !== 0) {
		for (const warning of Object.values(GitWarnings)) {
			if (warning.test(msg)) {
				const duration = start !== undefined ? `${getDurationMilliseconds(start)} ms` : '';
				Logger.warn(
					`[${cwd}] Git ${msg
						.trim()
						.replace(/fatal: /g, '')
						.replace(/\r?\n|\r/g, ` ${GlyphChars.Dot} `)} ${GlyphChars.Dot} ${duration}`,
				);
				return '';
			}
		}

		const match = GitErrors.badRevision.exec(msg);
		if (match != null) {
			const [, ref] = match;

			// Since looking up a ref with ^3 (e.g. looking for untracked files in a stash) can error on some versions of git just ignore it
			if (ref?.endsWith('^3')) return '';
		}
	}

	throw ex;
}

type ExitCodeOnlyGitCommandOptions = GitCommandOptions & { exitCodeOnly: true };

export class Git {
	// A map of running git commands -- avoids running duplicate overlaping commands
	private readonly pendingCommands = new Map<string, Promise<string | Buffer>>();

	async git(options: ExitCodeOnlyGitCommandOptions, ...args: any[]): Promise<number>;
	async git<T extends string | Buffer>(options: GitCommandOptions, ...args: any[]): Promise<T>;
	async git<T extends string | Buffer>(options: GitCommandOptions, ...args: any[]): Promise<T> {
		const start = hrtime();

		const { configs, correlationKey, errors: errorHandling, encoding, ...opts } = options;

		const runOpts: RunOptions = {
			...opts,
			encoding: (encoding ?? 'utf8') === 'utf8' ? 'utf8' : 'buffer',
			// Adds GCM environment variables to avoid any possible credential issues -- from https://github.com/Microsoft/vscode/issues/26573#issuecomment-338686581
			// Shouldn't *really* be needed but better safe than sorry
			env: {
				...process.env,
				...(options.env ?? emptyObj),
				GCM_INTERACTIVE: 'NEVER',
				GCM_PRESERVE_CREDS: 'TRUE',
				LC_ALL: 'C',
			},
		};

		const gitCommand = `[${runOpts.cwd}] git ${args.join(' ')}`;

		const command = `${correlationKey !== undefined ? `${correlationKey}:` : ''}${gitCommand}`;

		let waiting;
		let promise = this.pendingCommands.get(command);
		if (promise === undefined) {
			waiting = false;

			// Fixes https://github.com/gitkraken/vscode-gitlens/issues/73 & https://github.com/gitkraken/vscode-gitlens/issues/161
			// See https://stackoverflow.com/questions/4144417/how-to-handle-asian-characters-in-file-names-in-git-on-os-x
			args.splice(
				0,
				0,
				'-c',
				'core.quotepath=false',
				'-c',
				'color.ui=false',
				...(configs !== undefined ? configs : emptyArray),
			);

			if (process.platform === 'win32') {
				args.splice(0, 0, '-c', 'core.longpaths=true');
			}

			promise = run<T>(await this.path(), args, encoding ?? 'utf8', runOpts);

			this.pendingCommands.set(command, promise);
		} else {
			waiting = true;
			Logger.debug(`[GIT  ] ${gitCommand} ${GlyphChars.Dot} waiting...`);
		}

		let exception: Error | undefined;
		try {
			return (await promise) as T;
		} catch (ex) {
			exception = ex;

			switch (errorHandling) {
				case GitErrorHandling.Ignore:
					exception = undefined;
					return '' as T;

				case GitErrorHandling.Throw:
					throw ex;

				default: {
					const result = defaultExceptionHandler(ex, options.cwd, start);
					exception = undefined;
					return result as T;
				}
			}
		} finally {
			this.pendingCommands.delete(command);

			const duration = getDurationMilliseconds(start);
			const slow = duration > Logger.slowCallWarningThreshold;
			const status =
				slow || waiting
					? ` (${slow ? `slow${waiting ? ', waiting' : ''}` : ''}${waiting ? 'waiting' : ''})`
					: '';

			if (exception != null) {
				Logger.error(
					'',
					`[GIT  ] ${gitCommand} ${GlyphChars.Dot} ${(exception.message || String(exception) || '')
						.trim()
						.replace(/fatal: /g, '')
						.replace(/\r?\n|\r/g, ` ${GlyphChars.Dot} `)} ${GlyphChars.Dot} ${duration} ms${status}`,
				);
			} else if (slow) {
				Logger.warn(`[GIT  ] ${gitCommand} ${GlyphChars.Dot} ${duration} ms${status}`);
			} else {
				Logger.log(`[GIT  ] ${gitCommand} ${GlyphChars.Dot} ${duration} ms${status}`);
			}
			Logger.logGitCommand(
				`${gitCommand}${exception != null ? ` ${GlyphChars.Dot} FAILED` : ''}${waiting ? ' (waited)' : ''}`,
				duration,
				exception,
			);
		}
	}

	private gitLocator!: () => Promise<GitLocation>;
	setLocator(locator: () => Promise<GitLocation>): void {
		this.gitLocator = locator;
	}

	async path(): Promise<string> {
		return (await this.gitLocator()).path;
	}

	async version(): Promise<string> {
		return (await this.gitLocator()).version;
	}

	async isAtLeastVersion(minimum: string): Promise<boolean> {
		const result = compare(fromString(await this.version()), fromString(minimum));
		return result !== -1;
	}

	// Git commands

	add(repoPath: string | undefined, pathspec: string) {
		return this.git<string>({ cwd: repoPath }, 'add', '-A', '--', pathspec);
	}

	apply(repoPath: string | undefined, patch: string, options: { allowConflicts?: boolean } = {}) {
		const params = ['apply', '--whitespace=warn'];
		if (options.allowConflicts) {
			params.push('-3');
		}
		return this.git<string>({ cwd: repoPath, stdin: patch }, ...params);
	}

	private readonly ignoreRevsFileMap = new Map<string, boolean>();

	async blame(
		repoPath: string | undefined,
		fileName: string,
		ref?: string,
		options: { args?: string[] | null; ignoreWhitespace?: boolean; startLine?: number; endLine?: number } = {},
	) {
		const [file, root] = splitPath(fileName, repoPath, true);

		const params = ['blame', '--root', '--incremental'];

		if (options.ignoreWhitespace) {
			params.push('-w');
		}
		if (options.startLine != null && options.endLine != null) {
			params.push(`-L ${options.startLine},${options.endLine}`);
		}
		if (options.args != null) {
			params.push(...options.args);

			const index = params.indexOf('--ignore-revs-file');
			if (index !== -1) {
				// Ensure the version of Git supports the --ignore-revs-file flag, otherwise the blame will fail
				let supported = await this.isAtLeastVersion('2.23');
				if (supported) {
					let ignoreRevsFile = params[index + 1];
					if (!isAbsolute(ignoreRevsFile)) {
						ignoreRevsFile = joinPaths(repoPath ?? '', ignoreRevsFile);
					}

					const exists = this.ignoreRevsFileMap.get(ignoreRevsFile);
					if (exists !== undefined) {
						supported = exists;
					} else {
						// Ensure the specified --ignore-revs-file exists, otherwise the blame will fail
						try {
							supported = await fsExists(ignoreRevsFile);
						} catch {
							supported = false;
						}

						this.ignoreRevsFileMap.set(ignoreRevsFile, supported);
					}
				}

				if (!supported) {
					params.splice(index, 2);
				}
			}
		}

		let stdin;
		if (ref) {
			if (GitRevision.isUncommittedStaged(ref)) {
				// Pipe the blame contents to stdin
				params.push('--contents', '-');

				// Get the file contents for the staged version using `:`
				stdin = await this.show<string>(repoPath, fileName, ':');
			} else {
				params.push(ref);
			}
		}

		return this.git<string>({ cwd: root, stdin: stdin }, ...params, '--', file);
	}

	blame__contents(
		repoPath: string | undefined,
		fileName: string,
		contents: string,
		options: {
			args?: string[] | null;
			correlationKey?: string;
			ignoreWhitespace?: boolean;
			startLine?: number;
			endLine?: number;
		} = {},
	) {
		const [file, root] = splitPath(fileName, repoPath, true);

		const params = ['blame', '--root', '--incremental'];

		if (options.ignoreWhitespace) {
			params.push('-w');
		}
		if (options.startLine != null && options.endLine != null) {
			params.push(`-L ${options.startLine},${options.endLine}`);
		}
		if (options.args != null) {
			params.push(...options.args);
		}

		// Pipe the blame contents to stdin
		params.push('--contents', '-');

		return this.git<string>(
			{ cwd: root, stdin: contents, correlationKey: options.correlationKey },
			...params,
			'--',
			file,
		);
	}

	branch__containsOrPointsAt(
		repoPath: string,
		ref: string,
		{
			mode = 'contains',
			name = undefined,
			remotes = false,
		}: { mode?: 'contains' | 'pointsAt'; name?: string; remotes?: boolean } = {},
	) {
		const params = ['branch'];
		if (remotes) {
			params.push('-r');
		}
		params.push(mode === 'pointsAt' ? `--points-at=${ref}` : `--contains=${ref}`, '--format=%(refname:short)');
		if (name != null) {
			params.push(name);
		}

		return this.git<string>(
			{ cwd: repoPath, configs: ['-c', 'color.branch=false'], errors: GitErrorHandling.Ignore },
			...params,
		);
	}

	check_ignore(repoPath: string, ...files: string[]) {
		return this.git<string>(
			{ cwd: repoPath, errors: GitErrorHandling.Ignore, stdin: files.join('\0') },
			'check-ignore',
			'-z',
			'--stdin',
		);
	}

	check_mailmap(repoPath: string, author: string) {
		return this.git<string>({ cwd: repoPath, errors: GitErrorHandling.Ignore }, 'check-mailmap', author);
	}

	async check_ref_format(ref: string, repoPath?: string, options: { branch?: boolean } = { branch: true }) {
		const params = ['check-ref-format'];
		if (options.branch) {
			params.push('--branch');
		} else {
			params.push('--normalize');
		}

		try {
			const data = await this.git<string>(
				{ cwd: repoPath ?? '', errors: GitErrorHandling.Throw },
				...params,
				ref,
			);
			return Boolean(data.trim());
		} catch {
			return false;
		}
	}

	checkout(repoPath: string, ref: string, { createBranch, path }: { createBranch?: string; path?: string } = {}) {
		const params = ['checkout'];
		if (createBranch) {
			params.push('-b', createBranch, ref, '--');
		} else {
			params.push(ref, '--');

			if (path) {
				[path, repoPath] = splitPath(path, repoPath, true);

				params.push(path);
			}
		}

		return this.git<string>({ cwd: repoPath }, ...params);
	}

	async config__get(key: string, repoPath?: string, options: { local?: boolean } = {}) {
		const data = await this.git<string>(
			{ cwd: repoPath ?? '', errors: GitErrorHandling.Ignore, local: options.local },
			'config',
			'--get',
			key,
		);
		return data.length === 0 ? undefined : data.trim();
	}

	async config__get_regex(pattern: string, repoPath?: string, options: { local?: boolean } = {}) {
		const data = await this.git<string>(
			{ cwd: repoPath ?? '', errors: GitErrorHandling.Ignore, local: options.local },
			'config',
			'--get-regex',
			pattern,
		);
		return data.length === 0 ? undefined : data.trim();
	}

	async diff(
		repoPath: string,
		fileName: string,
		ref1?: string,
		ref2?: string,
		options: {
			encoding?: string;
			filters?: GitDiffFilter[];
			linesOfContext?: number;
			renames?: boolean;
			similarityThreshold?: number | null;
		} = {},
	): Promise<string> {
		const params = ['diff', '--no-ext-diff', '--minimal'];

		if (options.linesOfContext != null) {
			params.push(`-U${options.linesOfContext}`);
		}

		if (options.renames) {
			params.push(`-M${options.similarityThreshold == null ? '' : `${options.similarityThreshold}%`}`);
		}

		if (options.filters != null && options.filters.length !== 0) {
			params.push(`--diff-filter=${options.filters.join('')}`);
		}

		if (ref1) {
			// <sha>^3 signals an untracked file in a stash and if we are trying to find its parent, use the root sha
			if (ref1.endsWith('^3^')) {
				ref1 = rootSha;
			}
			params.push(GitRevision.isUncommittedStaged(ref1) ? '--staged' : ref1);
		}
		if (ref2) {
			params.push(GitRevision.isUncommittedStaged(ref2) ? '--staged' : ref2);
		}

		try {
			return await this.git<string>(
				{
					cwd: repoPath,
					configs: ['-c', 'color.diff=false'],
					encoding: options.encoding,
				},
				...params,
				'--',
				fileName,
			);
		} catch (ex) {
			const match = GitErrors.badRevision.exec(ex.message);
			if (match !== null) {
				const [, ref] = match;

				// If the bad ref is trying to find a parent ref, assume we hit to the last commit, so try again using the root sha
				if (ref === ref1 && ref != null && ref.endsWith('^')) {
					return this.diff(repoPath, fileName, rootSha, ref2, options);
				}
			}

			throw ex;
		}
	}

	async diff__contents(
		repoPath: string,
		fileName: string,
		ref: string,
		contents: string,
		options: { encoding?: string; filters?: GitDiffFilter[]; similarityThreshold?: number | null } = {},
	): Promise<string> {
		const params = [
			'diff',
			`-M${options.similarityThreshold == null ? '' : `${options.similarityThreshold}%`}`,
			'--no-ext-diff',
			'-U0',
			'--minimal',
		];

		if (options.filters != null && options.filters.length !== 0) {
			params.push(`--diff-filter=${options.filters.join('')}`);
		}

		// // <sha>^3 signals an untracked file in a stash and if we are trying to find its parent, use the root sha
		// if (ref.endsWith('^3^')) {
		// 	ref = rootSha;
		// }
		// params.push(GitRevision.isUncommittedStaged(ref) ? '--staged' : ref);

		params.push('--no-index');

		try {
			return await this.git<string>(
				{
					cwd: repoPath,
					configs: ['-c', 'color.diff=false'],
					encoding: options.encoding,
					stdin: contents,
				},
				...params,
				'--',
				fileName,
				// Pipe the contents to stdin
				'-',
			);
		} catch (ex) {
			if (ex instanceof RunError && ex.stdout) {
				return ex.stdout;
			}

			const match = GitErrors.badRevision.exec(ex.message);
			if (match !== null) {
				const [, matchedRef] = match;

				// If the bad ref is trying to find a parent ref, assume we hit to the last commit, so try again using the root sha
				if (matchedRef === ref && matchedRef != null && matchedRef.endsWith('^')) {
					return this.diff__contents(repoPath, fileName, rootSha, contents, options);
				}
			}

			throw ex;
		}
	}

	diff__name_status(
		repoPath: string,
		ref1?: string,
		ref2?: string,
		{ filters, similarityThreshold }: { filters?: GitDiffFilter[]; similarityThreshold?: number | null } = {},
	) {
		const params = [
			'diff',
			'--name-status',
			`-M${similarityThreshold == null ? '' : `${similarityThreshold}%`}`,
			'--no-ext-diff',
		];
		if (filters != null && filters.length !== 0) {
			params.push(`--diff-filter=${filters.join('')}`);
		}
		if (ref1) {
			params.push(ref1);
		}
		if (ref2) {
			params.push(ref2);
		}

		return this.git<string>({ cwd: repoPath, configs: ['-c', 'color.diff=false'] }, ...params, '--');
	}

	async diff__shortstat(repoPath: string, ref?: string) {
		const params = ['diff', '--shortstat', '--no-ext-diff'];
		if (ref) {
			params.push(ref);
		}

		try {
			return await this.git<string>({ cwd: repoPath, configs: ['-c', 'color.diff=false'] }, ...params, '--');
		} catch (ex) {
			const msg: string = ex?.toString() ?? '';
			if (GitErrors.noMergeBase.test(msg)) {
				return undefined;
			}

			throw ex;
		}
	}

	difftool(
		repoPath: string,
		fileName: string,
		tool: string,
		options: { ref1?: string; ref2?: string; staged?: boolean } = {},
	) {
		const params = ['difftool', '--no-prompt', `--tool=${tool}`];
		if (options.staged) {
			params.push('--staged');
		}
		if (options.ref1) {
			params.push(options.ref1);
		}
		if (options.ref2) {
			params.push(options.ref2);
		}

		return this.git<string>({ cwd: repoPath }, ...params, '--', fileName);
	}

	difftool__dir_diff(repoPath: string, tool: string, ref1: string, ref2?: string) {
		const params = ['difftool', '--dir-diff', `--tool=${tool}`, ref1];
		if (ref2) {
			params.push(ref2);
		}

		return this.git<string>({ cwd: repoPath }, ...params);
	}

	async fetch(
		repoPath: string,
		options:
			| { all?: boolean; branch?: undefined; prune?: boolean; remote?: string }
			| {
					all?: undefined;
					branch: string;
					prune?: undefined;
					pull?: boolean;
					remote: string;
					upstream: string;
			  } = {},
	): Promise<void> {
		const params = ['fetch'];

		if (options.prune) {
			params.push('--prune');
		}

		if (options.branch && options.remote) {
			if (options.upstream && options.pull) {
				params.push('-u', options.remote, `${options.upstream}:${options.branch}`);

				try {
					void (await this.git<string>({ cwd: repoPath }, ...params));
					return;
				} catch (ex) {
					const msg: string = ex?.toString() ?? '';
					if (GitErrors.noFastForward.test(msg)) {
						void window.showErrorMessage(
							`Unable to pull the '${options.branch}' branch, as it can't be fast-forwarded.`,
						);

						return;
					}

					throw ex;
				}
			} else {
				params.push(options.remote, options.branch);
			}
		} else if (options.remote) {
			params.push(options.remote);
		} else if (options.all) {
			params.push('--all');
		}

		void (await this.git<string>({ cwd: repoPath }, ...params));
	}

	for_each_ref__branch(repoPath: string, options: { all: boolean } = { all: false }) {
		const params = ['for-each-ref', `--format=${GitBranchParser.defaultFormat}`, 'refs/heads'];
		if (options.all) {
			params.push('refs/remotes');
		}

		return this.git<string>({ cwd: repoPath }, ...params);
	}

	log(
		repoPath: string,
		ref: string | undefined,
		{
			all,
			argsOrFormat,
			authors,
			limit,
			merges,
			ordering,
			similarityThreshold,
			since,
		}: {
			all?: boolean;
			argsOrFormat?: string | string[];
			authors?: GitUser[];
			limit?: number;
			merges?: boolean;
			ordering?: string | null;
			similarityThreshold?: number | null;
			since?: string;
		},
	) {
		if (argsOrFormat == null) {
			argsOrFormat = ['--name-status', `--format=${GitLogParser.defaultFormat}`];
		}

		if (typeof argsOrFormat === 'string') {
			argsOrFormat = [`--format=${argsOrFormat}`];
		}

		const params = [
			'log',
			...argsOrFormat,
			'--full-history',
			`-M${similarityThreshold == null ? '' : `${similarityThreshold}%`}`,
			'-m',
		];

		if (ordering) {
			params.push(`--${ordering}-order`);
		}

		if (limit) {
			params.push(`-n${limit + 1}`);
		}

		if (since) {
			params.push(`--since="${since}"`);
		}

		if (!merges) {
			params.push('--first-parent');
		}

		if (authors != null && authors.length !== 0) {
			if (!params.includes('--use-mailmap')) {
				params.push('--use-mailmap');
			}
			params.push(...authors.map(a => `--author=^${a.name} <${a.email}>$`));
		}

		if (all) {
			params.push('--all');
		}

		if (ref && !GitRevision.isUncommittedStaged(ref)) {
			params.push(ref);
		}

		return this.git<string>(
			{ cwd: repoPath, configs: ['-c', 'diff.renameLimit=0', '-c', 'log.showSignature=false'] },
			...params,
			'--',
		);
	}

	log__file(
		repoPath: string,
		fileName: string,
		ref: string | undefined,
		{
			all,
			argsOrFormat,
			// TODO@eamodio remove this in favor of argsOrFormat
			fileMode = 'full',
			filters,
			firstParent = false,
			limit,
			ordering,
			renames = true,
			reverse = false,
			since,
			skip,
			startLine,
			endLine,
		}: {
			all?: boolean;
			argsOrFormat?: string | string[];
			// TODO@eamodio remove this in favor of argsOrFormat
			fileMode?: 'full' | 'simple' | 'none';
			filters?: GitDiffFilter[];
			firstParent?: boolean;
			limit?: number;
			ordering?: string | null;
			renames?: boolean;
			reverse?: boolean;
			since?: string;
			skip?: number;
			startLine?: number;
			endLine?: number;
		} = {},
	) {
		const [file, root] = splitPath(fileName, repoPath, true);

		if (argsOrFormat == null) {
			argsOrFormat = [`--format=${GitLogParser.defaultFormat}`];
		}

		if (typeof argsOrFormat === 'string') {
			argsOrFormat = [`--format=${argsOrFormat}`];
		}

		const params = ['log', ...argsOrFormat];

		if (ordering) {
			params.push(`--${ordering}-order`);
		}

		if (limit && !reverse) {
			params.push(`-n${limit + 1}`);
		}

		if (skip) {
			params.push(`--skip=${skip}`);
		}

		if (since) {
			params.push(`--since="${since}"`);
		}

		if (all) {
			params.push('--all');
		}

		// Can't allow rename detection (`--follow`) if `all` or a `startLine` is specified
		if (renames && (all || startLine != null)) {
			renames = false;
		}

		params.push(renames ? '--follow' : '-m');
		if (/*renames ||*/ firstParent) {
			params.push('--first-parent');
			// In Git >= 2.29.0 `--first-parent` implies `-m`, so lets include it for consistency
			if (renames) {
				params.push('-m');
			}
		}

		if (filters != null && filters.length !== 0) {
			params.push(`--diff-filter=${filters.join('')}`);
		}

		if (fileMode !== 'none') {
			if (startLine == null) {
				// If this is the log of a folder, use `--name-status` to match non-file logs (for parsing)
				if (fileMode === 'simple' || isFolderGlob(file)) {
					params.push('--name-status');
				} else {
					params.push('--numstat', '--summary');
				}
			} else {
				// Don't include `--name-status`, `--numstat`, or `--summary` because they aren't supported with `-L`
				params.push(`-L ${startLine},${endLine == null ? startLine : endLine}:${file}`);
			}
		}

		if (ref && !GitRevision.isUncommittedStaged(ref)) {
			// If we are reversing, we must add a range (with HEAD) because we are using --ancestry-path for better reverse walking
			if (reverse) {
				params.push('--reverse', '--ancestry-path', `${ref}..HEAD`);
			} else {
				params.push(ref);
			}
		}

		// Don't specify a file spec when using a line number (so say the git docs)
		if (startLine == null) {
			params.push('--', file);
		}

		return this.git<string>({ cwd: root, configs: ['-c', 'log.showSignature=false'] }, ...params);
	}

	async log__file_recent(
		repoPath: string,
		fileName: string,
		{
			ordering,
			ref,
			similarityThreshold,
		}: { ordering?: string | null; ref?: string; similarityThreshold?: number | null } = {},
	) {
		const params = [
			'log',
			`-M${similarityThreshold == null ? '' : `${similarityThreshold}%`}`,
			'-n1',
			'--format=%H',
		];

		if (ordering) {
			params.push(`--${ordering}-order`);
		}

		if (ref) {
			params.push(ref);
		}

		const data = await this.git<string>(
			{ cwd: repoPath, configs: ['-c', 'log.showSignature=false'], errors: GitErrorHandling.Ignore },
			...params,
			'--',
			fileName,
		);
		return data.length === 0 ? undefined : data.trim();
	}

	async log__find_object(repoPath: string, objectId: string, ref: string, ordering: string | null, file?: string) {
		const params = ['log', '-n1', '--no-renames', '--format=%H', `--find-object=${objectId}`, ref];

		if (ordering) {
			params.push(`--${ordering}-order`);
		}

		if (file) {
			params.push('--', file);
		}

		const data = await this.git<string>(
			{ cwd: repoPath, configs: ['-c', 'log.showSignature=false'], errors: GitErrorHandling.Ignore },
			...params,
		);
		return data.length === 0 ? undefined : data.trim();
	}

	async log__recent(repoPath: string, ordering?: string | null) {
		const params = ['log', '-n1', '--format=%H'];

		if (ordering) {
			params.push(`--${ordering}-order`);
		}

		const data = await this.git<string>(
			{ cwd: repoPath, configs: ['-c', 'log.showSignature=false'], errors: GitErrorHandling.Ignore },
			...params,
			'--',
		);

		return data.length === 0 ? undefined : data.trim();
	}

	async log__recent_committerdate(repoPath: string, ordering?: string | null) {
		const params = ['log', '-n1', '--format=%ct'];

		if (ordering) {
			params.push(`--${ordering}-order`);
		}

		const data = await this.git<string>(
			{ cwd: repoPath, configs: ['-c', 'log.showSignature=false'], errors: GitErrorHandling.Ignore },
			...params,
			'--',
		);

		return data.length === 0 ? undefined : data.trim();
	}

	log__search(
		repoPath: string,
		search: string[] = emptyArray,
		{
			limit,
			ordering,
			skip,
			useShow,
		}: { limit?: number; ordering?: string | null; skip?: number; useShow?: boolean } = {},
	) {
		const params = [
			useShow ? 'show' : 'log',
			'--name-status',
			`--format=${GitLogParser.defaultFormat}`,
			'--use-mailmap',
		];

		if (limit && !useShow) {
			params.push(`-n${limit + 1}`);
		}

		if (skip && !useShow) {
			params.push(`--skip=${skip}`);
		}

		if (ordering && !useShow) {
			params.push(`--${ordering}-order`);
		}

		return this.git<string>(
			{ cwd: repoPath, configs: useShow ? undefined : ['-c', 'log.showSignature=false'] },
			...params,
			...search,
		);
	}

	//  log__shortstat(repoPath: string, options: { ref?: string }) {
	//     const params = ['log', '--shortstat', '--oneline'];
	//     if (options.ref && !GitRevision.isUncommittedStaged(options.ref)) {
	//         params.push(options.ref);
	//     }
	//     return this.git<string>({ cwd: repoPath, configs: ['-c', 'log.showSignature=false'] }, ...params, '--');
	// }

	async ls_files(
		repoPath: string,
		fileName: string,
		{ ref, untracked }: { ref?: string; untracked?: boolean } = {},
	): Promise<string | undefined> {
		const params = ['ls-files'];
		if (ref && !GitRevision.isUncommitted(ref)) {
			params.push(`--with-tree=${ref}`);
		}

		if (!ref && untracked) {
			params.push('-o');
		}

		const data = await this.git<string>(
			{ cwd: repoPath, errors: GitErrorHandling.Ignore },
			...params,
			'--',
			fileName,
		);
		return data.length === 0 ? undefined : data.trim();
	}

	ls_remote(repoPath: string, remote: string, ref?: string) {
		return this.git<string>({ cwd: repoPath }, 'ls-remote', remote, ref);
	}

	ls_remote__HEAD(repoPath: string, remote: string) {
		return this.git<string>({ cwd: repoPath }, 'ls-remote', '--symref', remote, 'HEAD');
	}

	async ls_tree(repoPath: string, ref: string, path?: string) {
		const params = ['ls-tree'];
		if (path) {
			params.push('-l', ref, '--', path);
		} else {
			params.push('-lrt', ref, '--');
		}
		const data = await this.git<string>({ cwd: repoPath, errors: GitErrorHandling.Ignore }, ...params);
		return data.length === 0 ? undefined : data.trim();
	}

	merge_base(repoPath: string, ref1: string, ref2: string, options?: { forkPoint?: boolean }) {
		const params = ['merge-base'];
		if (options?.forkPoint) {
			params.push('--fork-point');
		}

		return this.git<string>({ cwd: repoPath }, ...params, ref1, ref2);
	}

	async merge_base__is_ancestor(repoPath: string, ref1: string, ref2: string): Promise<boolean> {
		const params = ['merge-base', '--is-ancestor'];
		const exitCode = await this.git({ cwd: repoPath, exitCodeOnly: true }, ...params, ref1, ref2);
		return exitCode === 0;
	}

	reflog(
		repoPath: string,
		{
			all,
			branch,
			limit,
			ordering,
			skip,
		}: { all?: boolean; branch?: string; limit?: number; ordering?: string | null; skip?: number } = {},
	): Promise<string> {
		const params = ['log', '--walk-reflogs', `--format=${GitReflogParser.defaultFormat}`, '--date=iso8601'];

		if (ordering) {
			params.push(`--${ordering}-order`);
		}

		if (all) {
			params.push('--all');
		}

		if (limit) {
			params.push(`-n${limit}`);
		}

		if (skip) {
			params.push(`--skip=${skip}`);
		}

		if (branch) {
			params.push(branch);
		}

		return this.git<string>({ cwd: repoPath, configs: ['-c', 'log.showSignature=false'] }, ...params, '--');
	}

	remote(repoPath: string): Promise<string> {
		return this.git<string>({ cwd: repoPath }, 'remote', '-v');
	}

	remote__add(repoPath: string, name: string, url: string) {
		return this.git<string>({ cwd: repoPath }, 'remote', 'add', name, url);
	}

	remote__prune(repoPath: string, remoteName: string) {
		return this.git<string>({ cwd: repoPath }, 'remote', 'prune', remoteName);
	}

	remote__get_url(repoPath: string, remote: string): Promise<string> {
		return this.git<string>({ cwd: repoPath }, 'remote', 'get-url', remote);
	}

	reset(repoPath: string | undefined, fileName: string) {
		return this.git<string>({ cwd: repoPath }, 'reset', '-q', '--', fileName);
	}

	async rev_list__count(repoPath: string, ref: string): Promise<number | undefined> {
		let data = await this.git<string>(
			{ cwd: repoPath, errors: GitErrorHandling.Ignore },
			'rev-list',
			'--count',
			ref,
			'--',
		);
		data = data.trim();
		if (data.length === 0) return undefined;

		const result = parseInt(data, 10);
		return isNaN(result) ? undefined : result;
	}

	async rev_list__left_right(
		repoPath: string,
		refs: string[],
	): Promise<{ ahead: number; behind: number } | undefined> {
		const data = await this.git<string>(
			{ cwd: repoPath, errors: GitErrorHandling.Ignore },
			'rev-list',
			'--left-right',
			'--count',
			...refs,
			'--',
		);
		if (data.length === 0) return undefined;

		const parts = data.split('\t');
		if (parts.length !== 2) return undefined;

		const [ahead, behind] = parts;
		const result = {
			ahead: parseInt(ahead, 10),
			behind: parseInt(behind, 10),
		};

		if (isNaN(result.ahead) || isNaN(result.behind)) return undefined;

		return result;
	}

	async rev_parse__currentBranch(
		repoPath: string,
		ordering: string | null,
	): Promise<[string, string | undefined] | undefined> {
		try {
			const data = await this.git<string>(
				{ cwd: repoPath, errors: GitErrorHandling.Throw },
				'rev-parse',
				'--abbrev-ref',
				'--symbolic-full-name',
				'@',
				'@{u}',
				'--',
			);
			return [data, undefined];
		} catch (ex) {
			const msg: string = ex?.toString() ?? '';
			if (GitErrors.badRevision.test(msg) || GitWarnings.noUpstream.test(msg)) {
				if (ex.stdout != null && ex.stdout.length !== 0) {
					return [ex.stdout, undefined];
				}

				try {
					const data = await this.symbolic_ref(repoPath, 'HEAD');
					if (data != null) return [data.trim(), undefined];
				} catch {}

				try {
					const data = await this.symbolic_ref(repoPath, 'refs/remotes/origin/HEAD');
					if (data != null) return [data.trim().substr('origin/'.length), undefined];
				} catch (ex) {
					if (/is not a symbolic ref/.test(ex.stderr)) {
						try {
							const data = await this.ls_remote__HEAD(repoPath, 'origin');
							if (data != null) {
								const match = /ref:\s(\S+)\s+HEAD/m.exec(data);
								if (match != null) {
									const [, branch] = match;
									return [branch.substr('refs/heads/'.length), undefined];
								}
							}
						} catch {}
					}
				}

				const defaultBranch = (await this.config__get('init.defaultBranch', repoPath)) ?? 'main';
				const branchConfig = await this.config__get_regex(`branch\\.${defaultBranch}\\.+`, repoPath, {
					local: true,
				});

				let remote;
				let remoteBranch;

				if (branchConfig) {
					let match = /^branch\..+\.remote\s(.+)$/m.exec(branchConfig);
					if (match != null) {
						remote = match[1];
					}

					match = /^branch\..+\.merge\srefs\/heads\/(.+)$/m.exec(branchConfig);
					if (match != null) {
						remoteBranch = match[1];
					}
				}
				return [`${defaultBranch}${remote && remoteBranch ? `\n${remote}/${remoteBranch}` : ''}`, undefined];
			}

			if (GitWarnings.headNotABranch.test(msg)) {
				const sha = await this.log__recent(repoPath, ordering);
				if (sha === undefined) return undefined;

				return [`(HEAD detached at ${GitRevision.shorten(sha)})`, sha];
			}

			defaultExceptionHandler(ex, repoPath);
			return undefined;
		}
	}

	async rev_parse__git_dir(cwd: string): Promise<string | undefined> {
		const data = await this.git<string>({ cwd: cwd, errors: GitErrorHandling.Ignore }, 'rev-parse', '--git-dir');
		// Make sure to normalize: https://github.com/git-for-windows/git/issues/2478
		// Keep trailing spaces which are part of the directory name
		return data.length === 0 ? undefined : normalizePath(data.trimLeft().replace(/[\r|\n]+$/, ''));
	}

	async rev_parse__show_toplevel(cwd: string): Promise<string | undefined> {
		try {
			const data = await this.git<string>(
				{ cwd: cwd, errors: GitErrorHandling.Throw },
				'rev-parse',
				'--show-toplevel',
			);
			// Make sure to normalize: https://github.com/git-for-windows/git/issues/2478
			// Keep trailing spaces which are part of the directory name
			return data.length === 0 ? undefined : normalizePath(data.trimLeft().replace(/[\r|\n]+$/, ''));
		} catch (ex) {
			const inDotGit = /this operation must be run in a work tree/.test(ex.stderr);
			if (inDotGit || ex.code === 'ENOENT') {
				// If the `cwd` doesn't exist, walk backward to see if any parent folder exists
				let exists = inDotGit ? false : await fsExists(cwd);
				if (!exists) {
					do {
						const parent = dirname(cwd);
						if (parent === cwd || parent.length === 0) return undefined;

						cwd = parent;
						exists = await fsExists(cwd);
					} while (!exists);

					return this.rev_parse__show_toplevel(cwd);
				}
			}
			return undefined;
		}
	}

	async rev_parse__verify(repoPath: string, ref: string, fileName?: string): Promise<string | undefined> {
		const params = ['rev-parse', '--verify'];

		if (await this.isAtLeastVersion('2.30')) {
			params.push('--end-of-options');
		}

		const data = await this.git<string>(
			{ cwd: repoPath, errors: GitErrorHandling.Ignore },
			...params,
			fileName ? `${ref}:./${fileName}` : `${ref}^{commit}`,
		);
		return data.length === 0 ? undefined : data.trim();
	}

	async show<TOut extends string | Buffer>(
		repoPath: string | undefined,
		fileName: string,
		ref: string,
		options: {
			encoding?: 'binary' | 'ascii' | 'utf8' | 'utf16le' | 'ucs2' | 'base64' | 'latin1' | 'hex' | 'buffer';
		} = {},
	): Promise<TOut | undefined> {
		const [file, root] = splitPath(fileName, repoPath, true);

		if (GitRevision.isUncommittedStaged(ref)) {
			ref = ':';
		}
		if (GitRevision.isUncommitted(ref)) throw new Error(`ref=${ref} is uncommitted`);

		const opts: GitCommandOptions = {
			configs: ['-c', 'log.showSignature=false'],
			cwd: root,
			encoding: options.encoding ?? 'utf8',
			errors: GitErrorHandling.Throw,
		};
		const args = ref.endsWith(':') ? `${ref}./${file}` : `${ref}:./${file}`;

		try {
			const data = await this.git<TOut>(opts, 'show', '--textconv', args, '--');
			return data;
		} catch (ex) {
			const msg: string = ex?.toString() ?? '';
			if (ref === ':' && GitErrors.badRevision.test(msg)) {
				return this.show<TOut>(repoPath, fileName, 'HEAD:', options);
			}

			if (
				GitErrors.badRevision.test(msg) ||
				GitWarnings.notFound.test(msg) ||
				GitWarnings.foundButNotInRevision.test(msg)
			) {
				return undefined;
			}

			return defaultExceptionHandler(ex, opts.cwd) as TOut;
		}
	}

	show__diff(
		repoPath: string,
		fileName: string,
		ref: string,
		originalFileName?: string,
		{ similarityThreshold }: { similarityThreshold?: number | null } = {},
	) {
		const params = [
			'show',
			`-M${similarityThreshold == null ? '' : `${similarityThreshold}%`}`,
			'--format=',
			'--minimal',
			'-U0',
			ref,
			'--',
			fileName,
		];
		if (originalFileName != null && originalFileName.length !== 0) {
			params.push(originalFileName);
		}

		return this.git<string>({ cwd: repoPath }, ...params);
	}

	show__name_status(repoPath: string, fileName: string, ref: string) {
		return this.git<string>({ cwd: repoPath }, 'show', '--name-status', '--format=', ref, '--', fileName);
	}

	show_ref__tags(repoPath: string) {
		return this.git<string>({ cwd: repoPath, errors: GitErrorHandling.Ignore }, 'show-ref', '--tags');
	}

	stash__apply(repoPath: string, stashName: string, deleteAfter: boolean): Promise<string | undefined> {
		if (!stashName) return Promise.resolve(undefined);
		return this.git<string>({ cwd: repoPath }, 'stash', deleteAfter ? 'pop' : 'apply', stashName);
	}

	async stash__delete(repoPath: string, stashName: string, ref?: string) {
		if (!stashName) return undefined;

		if (ref) {
			const stashRef = await this.git<string>(
				{ cwd: repoPath, errors: GitErrorHandling.Ignore },
				'show',
				'--format=%H',
				'--no-patch',
				stashName,
			);
			if (stashRef?.trim() !== ref) {
				throw new Error('Unable to delete stash; mismatch with stash number');
			}
		}

		return this.git<string>({ cwd: repoPath }, 'stash', 'drop', stashName);
	}

	stash__list(
		repoPath: string,
		{ args, similarityThreshold }: { args?: string[]; similarityThreshold?: number | null },
	) {
		if (args == null) {
			args = ['--name-status'];
		}

		return this.git<string>(
			{ cwd: repoPath },
			'stash',
			'list',
			...args,
			`-M${similarityThreshold == null ? '' : `${similarityThreshold}%`}`,
		);
	}

	async stash__push(
		repoPath: string,
		message?: string,
		{
			includeUntracked,
			keepIndex,
			pathspecs,
			stdin,
		}: { includeUntracked?: boolean; keepIndex?: boolean; pathspecs?: string[]; stdin?: boolean } = {},
	): Promise<void> {
		const params = ['stash', 'push'];

		if (includeUntracked || (pathspecs != null && pathspecs.length !== 0)) {
			params.push('-u');
		}

		if (keepIndex) {
			params.push('-k');
		}

		if (message) {
			params.push('-m', message);
		}

		if (stdin && pathspecs != null && pathspecs.length !== 0) {
			void (await this.git<string>(
				{ cwd: repoPath, stdin: pathspecs.join('\0') },
				...params,
				'--pathspec-from-file=-',
				'--pathspec-file-nul',
			));

			return;
		}

		params.push('--');
		if (pathspecs != null && pathspecs.length !== 0) {
			params.push(...pathspecs);
		}

		void (await this.git<string>({ cwd: repoPath }, ...params));
	}

	async status(
		repoPath: string,
		porcelainVersion: number = 1,
		{ similarityThreshold }: { similarityThreshold?: number | null } = {},
	): Promise<string> {
		const params = [
			'status',
			porcelainVersion >= 2 ? `--porcelain=v${porcelainVersion}` : '--porcelain',
			'--branch',
			'-u',
		];
		if (await this.isAtLeastVersion('2.18')) {
			params.push(`--find-renames${similarityThreshold == null ? '' : `=${similarityThreshold}%`}`);
		}

		return this.git<string>(
			{ cwd: repoPath, configs: ['-c', 'color.status=false'], env: { GIT_OPTIONAL_LOCKS: '0' } },
			...params,
			'--',
		);
	}

	async status__file(
		repoPath: string,
		fileName: string,
		porcelainVersion: number = 1,
		{ similarityThreshold }: { similarityThreshold?: number | null } = {},
	): Promise<string> {
		const [file, root] = splitPath(fileName, repoPath, true);

		const params = ['status', porcelainVersion >= 2 ? `--porcelain=v${porcelainVersion}` : '--porcelain'];
		if (await this.isAtLeastVersion('2.18')) {
			params.push(`--find-renames${similarityThreshold == null ? '' : `=${similarityThreshold}%`}`);
		}

		return this.git<string>(
			{ cwd: root, configs: ['-c', 'color.status=false'], env: { GIT_OPTIONAL_LOCKS: '0' } },
			...params,
			'--',
			file,
		);
	}

	symbolic_ref(repoPath: string, ref: string) {
		return this.git<string>({ cwd: repoPath }, 'symbolic-ref', '--short', ref);
	}

	tag(repoPath: string) {
		return this.git<string>({ cwd: repoPath }, 'tag', '-l', `--format=${GitTagParser.defaultFormat}`);
	}

	worktree__add(
		repoPath: string,
		path: string,
		{
			commitish,
			createBranch,
			detach,
			force,
		}: { commitish?: string; createBranch?: string; detach?: boolean; force?: boolean } = {},
	) {
		const params = ['worktree', 'add'];
		if (force) {
			params.push('--force');
		}
		if (createBranch) {
			params.push('-b', createBranch);
		}
		if (detach) {
			params.push('--detach');
		}
		params.push(path);
		if (commitish) {
			params.push(commitish);
		}
		return this.git<string>({ cwd: repoPath }, ...params);
	}

	worktree__list(repoPath: string) {
		return this.git<string>({ cwd: repoPath }, 'worktree', 'list', '--porcelain');
	}

	worktree__remove(repoPath: string, worktree: string, { force }: { force?: boolean } = {}) {
		const params = ['worktree', 'remove'];
		if (force) {
			params.push('--force');
		}
		params.push(worktree);

		return this.git<string>({ cwd: repoPath, errors: GitErrorHandling.Throw }, ...params);
	}

	async readDotGitFile(
		repoPath: string,
		paths: string[],
		options?: { numeric?: false; throw?: boolean; trim?: boolean },
	): Promise<string | undefined>;
	async readDotGitFile(
		repoPath: string,
		path: string[],
		options?: { numeric: true; throw?: boolean; trim?: boolean },
	): Promise<number | undefined>;
	async readDotGitFile(
		repoPath: string,
		pathParts: string[],
		options?: { numeric?: boolean; throw?: boolean; trim?: boolean },
	): Promise<string | number | undefined> {
		try {
			const bytes = await workspace.fs.readFile(Uri.file(joinPaths(repoPath, '.git', ...pathParts)));
			let contents = textDecoder.decode(bytes);
			contents = options?.trim ?? true ? contents.trim() : contents;

			if (options?.numeric) {
				const number = Number.parseInt(contents, 10);
				return isNaN(number) ? undefined : number;
			}

			return contents;
		} catch (ex) {
			if (options?.throw) throw ex;

			return undefined;
		}
	}
}
