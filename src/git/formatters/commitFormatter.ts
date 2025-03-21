import { Uri } from 'vscode';
import type {
	Action,
	ActionContext,
	HoverCommandsActionContext,
	OpenPullRequestActionContext,
} from '../../api/gitlens';
import { getPresenceDataUri } from '../../avatars';
import {
	ConnectRemoteProviderCommand,
	DiffWithCommand,
	OpenCommitOnRemoteCommand,
	OpenFileAtRevisionCommand,
	ShowQuickCommitCommand,
	ShowQuickCommitFileCommand,
} from '../../commands';
import { Command } from '../../commands/base';
import { DateStyle, FileAnnotationType } from '../../configuration';
import { Commands, GlyphChars } from '../../constants';
import { Container } from '../../container';
import { emojify } from '../../emojis';
import { join, map } from '../../system/iterable';
import { PromiseCancelledError } from '../../system/promise';
import { escapeMarkdown, getSuperscript, TokenOptions } from '../../system/string';
import { ContactPresence } from '../../vsls/vsls';
import { PreviousLineComparisonUrisResult } from '../gitProvider';
import { GitCommit, GitRemote, GitRevision, IssueOrPullRequest, PullRequest } from '../models';
import { RemoteProvider } from '../remotes/provider';
import { FormatOptions, Formatter } from './formatter';

export interface CommitFormatOptions extends FormatOptions {
	autolinkedIssuesOrPullRequests?: Map<string, IssueOrPullRequest | PromiseCancelledError | undefined>;
	avatarSize?: number;
	dateStyle?: DateStyle;
	editor?: { line: number; uri: Uri };
	footnotes?: Map<number, string>;
	getBranchAndTagTips?: (sha: string, options?: { compact?: boolean; icons?: boolean }) => string | undefined;
	markdown?: boolean;
	messageAutolinks?: boolean;
	messageIndent?: number;
	messageTruncateAtNewLine?: boolean;
	pullRequestOrRemote?: PullRequest | PromiseCancelledError | GitRemote;
	pullRequestPendingMessage?: string;
	presence?: ContactPresence;
	previousLineComparisonUris?: PreviousLineComparisonUrisResult;
	remotes?: GitRemote<RemoteProvider>[];
	unpublished?: boolean;

	tokenOptions?: {
		ago?: TokenOptions;
		agoOrDate?: TokenOptions;
		agoOrDateShort?: TokenOptions;
		author?: TokenOptions;
		authorAgo?: TokenOptions;
		authorAgoOrDate?: TokenOptions;
		authorAgoOrDateShort?: TokenOptions;
		authorDate?: TokenOptions;
		authorNotYou?: TokenOptions;
		avatar?: TokenOptions;
		changes?: TokenOptions;
		changesDetail?: TokenOptions;
		changesShort?: TokenOptions;
		commands?: TokenOptions;
		committerAgo?: TokenOptions;
		committerAgoOrDate?: TokenOptions;
		committerAgoOrDateShort?: TokenOptions;
		committerDate?: TokenOptions;
		date?: TokenOptions;
		email?: TokenOptions;
		footnotes?: TokenOptions;
		id?: TokenOptions;
		link?: TokenOptions;
		message?: TokenOptions;
		pullRequest?: TokenOptions;
		pullRequestAgo?: TokenOptions;
		pullRequestAgoOrDate?: TokenOptions;
		pullRequestDate?: TokenOptions;
		pullRequestState?: TokenOptions;
		sha?: TokenOptions;
		stashName?: TokenOptions;
		stashNumber?: TokenOptions;
		stashOnRef?: TokenOptions;
		tips?: TokenOptions;
	};
}

export class CommitFormatter extends Formatter<GitCommit, CommitFormatOptions> {
	private get _authorDate() {
		return this._item.author.formatDate(this._options.dateFormat);
	}

	private get _authorDateAgo() {
		return this._item.author.fromNow();
	}

	private get _authorDateAgoShort() {
		return this._item.author.fromNow(true);
	}

	private get _committerDate() {
		return this._item.committer.formatDate(this._options.dateFormat);
	}

	private get _committerDateAgo() {
		return this._item.committer.fromNow();
	}

	private get _committerDateAgoShort() {
		return this._item.committer.fromNow(true);
	}

	private get _date() {
		return this._item.formatDate(this._options.dateFormat);
	}

	private get _dateAgo() {
		return this._item.formatDateFromNow();
	}

	private get _dateAgoShort() {
		return this._item.formatDateFromNow(true);
	}

	private get _pullRequestDate() {
		const { pullRequestOrRemote: pr } = this._options;
		if (pr == null || !PullRequest.is(pr)) return '';

		return pr.formatDate(this._options.dateFormat) ?? '';
	}

	private get _pullRequestDateAgo() {
		const { pullRequestOrRemote: pr } = this._options;
		if (pr == null || !PullRequest.is(pr)) return '';

		return pr.formatDateFromNow() ?? '';
	}

	private get _pullRequestDateOrAgo() {
		const dateStyle =
			this._options.dateStyle != null ? this._options.dateStyle : Container.instance.config.defaultDateStyle;
		return dateStyle === DateStyle.Absolute ? this._pullRequestDate : this._pullRequestDateAgo;
	}

	get ago(): string {
		return this._padOrTruncate(this._dateAgo, this._options.tokenOptions.ago);
	}

	get agoOrDate(): string {
		const dateStyle =
			this._options.dateStyle != null ? this._options.dateStyle : Container.instance.config.defaultDateStyle;
		return this._padOrTruncate(
			dateStyle === DateStyle.Absolute ? this._date : this._dateAgo,
			this._options.tokenOptions.agoOrDate,
		);
	}

	get agoOrDateShort(): string {
		const dateStyle =
			this._options.dateStyle != null ? this._options.dateStyle : Container.instance.config.defaultDateStyle;
		return this._padOrTruncate(
			dateStyle === DateStyle.Absolute ? this._date : this._dateAgoShort,
			this._options.tokenOptions.agoOrDateShort,
		);
	}

	get author(): string {
		const { name, email } = this._item.author;
		const author = this._padOrTruncate(name, this._options.tokenOptions.author);
		if (!this._options.markdown) return author;

		return `[${author}](mailto:${email} "Email ${name} (${email})")`;
	}

	get authorAgo(): string {
		return this._padOrTruncate(this._authorDateAgo, this._options.tokenOptions.authorAgo);
	}

	get authorAgoOrDate(): string {
		const dateStyle =
			this._options.dateStyle != null ? this._options.dateStyle : Container.instance.config.defaultDateStyle;
		return this._padOrTruncate(
			dateStyle === DateStyle.Absolute ? this._authorDate : this._authorDateAgo,
			this._options.tokenOptions.authorAgoOrDate,
		);
	}

	get authorAgoOrDateShort(): string {
		const dateStyle =
			this._options.dateStyle != null ? this._options.dateStyle : Container.instance.config.defaultDateStyle;
		return this._padOrTruncate(
			dateStyle === DateStyle.Absolute ? this._authorDate : this._authorDateAgoShort,
			this._options.tokenOptions.authorAgoOrDateShort,
		);
	}

	get authorDate(): string {
		return this._padOrTruncate(this._authorDate, this._options.tokenOptions.authorDate);
	}

	get authorNotYou(): string {
		const { name, email } = this._item.author;
		if (name === 'You') return this._padOrTruncate('', this._options.tokenOptions.authorNotYou);

		const author = this._padOrTruncate(name, this._options.tokenOptions.authorNotYou);
		if (!this._options.markdown) return author;

		return `[${author}](mailto:${email} "Email ${name} (${email})")`;
	}

	get avatar(): string | Promise<string> {
		if (!this._options.markdown || !Container.instance.config.hovers.avatars) {
			return this._padOrTruncate('', this._options.tokenOptions.avatar);
		}

		const { name } = this._item.author;

		const presence = this._options.presence;
		if (presence != null) {
			const title = `${name} ${name === 'You' ? 'are' : 'is'} ${
				presence.status === 'dnd' ? 'in ' : ''
			}${presence.statusText.toLocaleLowerCase()}`;

			const avatarMarkdownPromise = this._getAvatarMarkdown(title, this._options.avatarSize);
			return avatarMarkdownPromise.then(md =>
				this._padOrTruncate(
					`${md}${this._getPresenceMarkdown(presence, title)}`,
					this._options.tokenOptions.avatar,
				),
			);
		}

		return this._getAvatarMarkdown(name, this._options.avatarSize);
	}

	private async _getAvatarMarkdown(title: string, size?: number) {
		size = size ?? Container.instance.config.hovers.avatarSize;
		const avatarPromise = this._item.getAvatarUri({
			defaultStyle: Container.instance.config.defaultGravatarsStyle,
			size: size,
		});
		return this._padOrTruncate(
			`![${title}](${(await avatarPromise).toString(true)}|width=${size},height=${size} "${title}")`,
			this._options.tokenOptions.avatar,
		);
	}

	private _getPresenceMarkdown(presence: ContactPresence, title: string) {
		return `![${title}](${getPresenceDataUri(presence.status)} "${title}")`;
	}

	get changes(): string {
		return this._padOrTruncate(
			GitCommit.is(this._item) ? this._item.formatStats() : '',
			this._options.tokenOptions.changes,
		);
	}

	get changesDetail(): string {
		return this._padOrTruncate(
			GitCommit.is(this._item) ? this._item.formatStats({ expand: true, separator: ', ' }) : '',
			this._options.tokenOptions.changesDetail,
		);
	}

	get changesShort(): string {
		return this._padOrTruncate(
			GitCommit.is(this._item) ? this._item.formatStats({ compact: true, separator: '' }) : '',
			this._options.tokenOptions.changesShort,
		);
	}

	get commands(): string {
		if (!this._options.markdown) return this._padOrTruncate('', this._options.tokenOptions.commands);

		let commands;
		if (this._item.isUncommitted) {
			const { previousLineComparisonUris: diffUris } = this._options;
			if (diffUris?.previous != null) {
				commands = `\`${this._padOrTruncate(
					GitRevision.shorten(
						GitRevision.isUncommittedStaged(diffUris.current.sha)
							? diffUris.current.sha
							: GitRevision.uncommitted,
					)!,
					this._options.tokenOptions.commands,
				)}\``;

				commands += ` &nbsp;[$(chevron-left)$(compare-changes)](${DiffWithCommand.getMarkdownCommandArgs({
					lhs: {
						sha: diffUris.previous.sha ?? '',
						uri: diffUris.previous.documentUri(),
					},
					rhs: {
						sha: diffUris.current.sha ?? '',
						uri: diffUris.current.documentUri(),
					},
					repoPath: this._item.repoPath,
					line: this._options.editor?.line,
				})} "Open Changes with Previous Revision")`;

				commands += ` &nbsp;&nbsp;[$(versions)](${OpenFileAtRevisionCommand.getMarkdownCommandArgs(
					Container.instance.git.getRevisionUri(diffUris.previous),
					FileAnnotationType.Blame,
					this._options.editor?.line,
				)} "Open Blame Prior to this Change")`;
			} else {
				commands = `\`${this._padOrTruncate(
					GitRevision.shorten(
						this._item.isUncommittedStaged ? GitRevision.uncommittedStaged : GitRevision.uncommitted,
					)!,
					this._options.tokenOptions.commands,
				)}\``;
			}

			return commands;
		}

		const separator = ' &nbsp;&nbsp;|&nbsp;&nbsp; ';

		commands = `---\n\n[\`$(git-commit) ${this.id}\`](${ShowQuickCommitCommand.getMarkdownCommandArgs(
			this._item.sha,
		)} "Show Commit")`;

		commands += ` &nbsp;[$(chevron-left)$(compare-changes)](${DiffWithCommand.getMarkdownCommandArgs(
			this._item,
			this._options.editor?.line,
		)} "Open Changes with Previous Revision")`;

		if (this._item.file != null && this._item.unresolvedPreviousSha != null) {
			const uri = Container.instance.git.getRevisionUri(
				this._item.unresolvedPreviousSha,
				this._item.file.originalPath ?? this._item.file?.path,
				this._item.repoPath,
			);
			commands += ` &nbsp;&nbsp;[$(versions)](${OpenFileAtRevisionCommand.getMarkdownCommandArgs(
				uri,
				FileAnnotationType.Blame,
				this._options.editor?.line,
			)} "Open Blame Prior to this Change")`;
		}

		if (this._options.remotes != null && this._options.remotes.length !== 0) {
			const providers = GitRemote.getHighlanderProviders(this._options.remotes);

			commands += ` &nbsp;&nbsp;[$(globe)](${OpenCommitOnRemoteCommand.getMarkdownCommandArgs(
				this._item.sha,
			)} "Open Commit on ${providers?.length ? providers[0].name : 'Remote'}")`;
		}

		const { pullRequestOrRemote: pr } = this._options;
		if (pr != null) {
			if (PullRequest.is(pr)) {
				commands += `${separator}[$(git-pull-request) PR #${
					pr.id
				}](${getMarkdownActionCommand<OpenPullRequestActionContext>('openPullRequest', {
					repoPath: this._item.repoPath,
					provider: { id: pr.provider.id, name: pr.provider.name, domain: pr.provider.domain },
					pullRequest: { id: pr.id, url: pr.url },
				})} "Open Pull Request \\#${pr.id}${
					Container.instance.actionRunners.count('openPullRequest') == 1 ? ` on ${pr.provider.name}` : '...'
				}\n${GlyphChars.Dash.repeat(2)}\n${escapeMarkdown(pr.title).replace(/"/g, '\\"')}\n${
					pr.state
				}, ${pr.formatDateFromNow()}")`;
			} else if (pr instanceof PromiseCancelledError) {
				commands += `${separator}[$(git-pull-request) PR $(loading~spin)](command:${Commands.RefreshHover} "Searching for a Pull Request (if any) that introduced this commit...")`;
			} else if (pr.provider != null && Container.instance.config.integrations.enabled) {
				commands += `${separator}[$(plug) Connect to ${pr.provider.name}${
					GlyphChars.Ellipsis
				}](${ConnectRemoteProviderCommand.getMarkdownCommandArgs(pr)} "Connect to ${
					pr.provider.name
				} to enable the display of the Pull Request (if any) that introduced this commit")`;
			}
		}

		if (Container.instance.actionRunners.count('hover.commands') > 0) {
			const { name, email } = this._item.author;

			commands += `${separator}[$(organization) Team${GlyphChars.SpaceThinnest}${
				GlyphChars.Ellipsis
			}](${getMarkdownActionCommand<HoverCommandsActionContext>('hover.commands', {
				repoPath: this._item.repoPath,
				commit: {
					sha: this._item.sha,
					author: {
						name: name,
						email: email,
						presence: this._options.presence,
					},
				},
				file:
					this._options.editor != null
						? {
								uri: this._options.editor?.uri.toString(),
								line: this._options.editor?.line,
						  }
						: undefined,
			})} "Show Team Actions")`;
		}

		const gitUri = this._item.getGitUri();
		commands += `${separator}[$(ellipsis)](${ShowQuickCommitFileCommand.getMarkdownCommandArgs(
			gitUri != null
				? {
						revisionUri: Container.instance.git.getRevisionUri(gitUri).toString(true),
				  }
				: { commit: this._item },
		)} "Show More Actions")`;

		return this._padOrTruncate(commands, this._options.tokenOptions.commands);
	}

	get committerAgo(): string {
		return this._padOrTruncate(this._committerDateAgo, this._options.tokenOptions.committerAgo);
	}

	get committerAgoOrDate(): string {
		const dateStyle =
			this._options.dateStyle != null ? this._options.dateStyle : Container.instance.config.defaultDateStyle;
		return this._padOrTruncate(
			dateStyle === DateStyle.Absolute ? this._committerDate : this._committerDateAgo,
			this._options.tokenOptions.committerAgoOrDate,
		);
	}

	get committerAgoOrDateShort(): string {
		const dateStyle =
			this._options.dateStyle != null ? this._options.dateStyle : Container.instance.config.defaultDateStyle;
		return this._padOrTruncate(
			dateStyle === DateStyle.Absolute ? this._committerDate : this._committerDateAgoShort,
			this._options.tokenOptions.committerAgoOrDateShort,
		);
	}

	get committerDate(): string {
		return this._padOrTruncate(this._committerDate, this._options.tokenOptions.committerDate);
	}

	get date(): string {
		return this._padOrTruncate(this._date, this._options.tokenOptions.date);
	}

	get email(): string {
		const { email } = this._item.author;
		return this._padOrTruncate(email ?? '', this._options.tokenOptions.email);
	}

	get footnotes(): string {
		return this._padOrTruncate(
			this._options.footnotes == null || this._options.footnotes.size === 0
				? ''
				: join(
						map(this._options.footnotes, ([i, footnote]) =>
							this._options.markdown ? footnote : `${getSuperscript(i)} ${footnote}`,
						),
						this._options.markdown ? '\\\n' : '\n',
				  ),
			this._options.tokenOptions.footnotes,
		);
	}

	get id(): string {
		const sha = this._padOrTruncate(this._item.shortSha ?? '', this._options.tokenOptions.id);
		if (this._options.markdown && this._options.unpublished) {
			return `<span style="color:#35b15e;">${sha} (unpublished)</span>`;
		}

		return sha;
	}

	get link(): string {
		if (!this._options.markdown) return this.id;

		const sha = this._padOrTruncate(this._item.shortSha ?? '', this._options.tokenOptions.id);
		const link = `[\`$(git-commit) ${sha}\`](${ShowQuickCommitCommand.getMarkdownCommandArgs(
			this._item.sha,
		)} "Show Commit")`;

		return this._padOrTruncate(link, this._options.tokenOptions.link);
	}

	get message(): string {
		if (this._item.isUncommitted) {
			const confliced = this._item.file?.hasConflicts ?? false;
			const staged =
				this._item.isUncommittedStaged ||
				(this._options.previousLineComparisonUris?.current?.isUncommittedStaged ?? false);

			return this._padOrTruncate(
				`${this._options.markdown ? '\n> ' : ''}${
					confliced ? 'Merge' : staged ? 'Staged' : 'Uncommitted'
				} changes`,
				this._options.tokenOptions.message,
			);
		}

		let message = this._options.messageTruncateAtNewLine
			? this._item.summary
			: this._item.message ?? this._item.summary;

		message = emojify(message);
		message = this._padOrTruncate(message, this._options.tokenOptions.message);

		if (this._options.messageAutolinks) {
			message = Container.instance.autolinks.linkify(
				this._options.markdown ? escapeMarkdown(message, { quoted: true }) : message,
				this._options.markdown ?? false,
				this._options.remotes,
				this._options.autolinkedIssuesOrPullRequests,
				this._options.footnotes,
			);
		}

		if (this._options.messageIndent != null && !this._options.markdown) {
			message = message.replace(/^/gm, GlyphChars.Space.repeat(this._options.messageIndent));
		}

		return this._options.markdown ? `\n> ${message}` : message;
	}

	get pullRequest(): string {
		const { pullRequestOrRemote: pr } = this._options;
		if (pr == null) return this._padOrTruncate('', this._options.tokenOptions.pullRequest);

		let text;
		if (PullRequest.is(pr)) {
			if (this._options.markdown) {
				const prTitle = escapeMarkdown(pr.title).replace(/"/g, '\\"').trim();

				text = `PR [**#${pr.id}**](${getMarkdownActionCommand<OpenPullRequestActionContext>('openPullRequest', {
					repoPath: this._item.repoPath,
					provider: { id: pr.provider.id, name: pr.provider.name, domain: pr.provider.domain },
					pullRequest: { id: pr.id, url: pr.url },
				})} "Open Pull Request \\#${pr.id}${
					Container.instance.actionRunners.count('openPullRequest') == 1 ? ` on ${pr.provider.name}` : '...'
				}\n${GlyphChars.Dash.repeat(2)}\n${escapeMarkdown(pr.title).replace(/"/g, '\\"')}\n${
					pr.state
				}, ${pr.formatDateFromNow()}")`;

				if (this._options.footnotes != null) {
					const index = this._options.footnotes.size + 1;
					this._options.footnotes.set(
						index,
						`${PullRequest.getMarkdownIcon(pr)} [**${prTitle}**](${pr.url} "Open Pull Request \\#${
							pr.id
						} on ${pr.provider.name}")\\\n${GlyphChars.Space.repeat(4)} #${
							pr.id
						} ${pr.state.toLocaleLowerCase()} ${pr.formatDateFromNow()}`,
					);
				}
			} else if (this._options.footnotes != null) {
				const index = this._options.footnotes.size + 1;
				this._options.footnotes.set(
					index,
					`PR #${pr.id}: ${pr.title}  ${GlyphChars.Dot}  ${pr.state}, ${pr.formatDateFromNow()}`,
				);

				text = `PR #${pr.id}${getSuperscript(index)}`;
			} else {
				text = `PR #${pr.id}`;
			}
		} else if (pr instanceof PromiseCancelledError) {
			text = this._options.markdown
				? `[PR $(loading~spin)](command:${Commands.RefreshHover} "Searching for a Pull Request (if any) that introduced this commit...")`
				: this._options?.pullRequestPendingMessage ?? '';
		} else {
			return this._padOrTruncate('', this._options.tokenOptions.pullRequest);
		}

		return this._padOrTruncate(text, this._options.tokenOptions.pullRequest);
	}

	get pullRequestAgo(): string {
		return this._padOrTruncate(this._pullRequestDateAgo, this._options.tokenOptions.pullRequestAgo);
	}

	get pullRequestAgoOrDate(): string {
		return this._padOrTruncate(this._pullRequestDateOrAgo, this._options.tokenOptions.pullRequestAgoOrDate);
	}

	get pullRequestDate(): string {
		return this._padOrTruncate(this._pullRequestDate, this._options.tokenOptions.pullRequestDate);
	}

	get pullRequestState(): string {
		const { pullRequestOrRemote: pr } = this._options;
		return this._padOrTruncate(
			pr == null || !PullRequest.is(pr) ? '' : pr.state ?? '',
			this._options.tokenOptions.pullRequestState,
		);
	}

	get sha(): string {
		return this._padOrTruncate(this._item.shortSha ?? '', this._options.tokenOptions.sha);
	}

	get stashName(): string {
		return this._padOrTruncate(this._item.stashName ?? '', this._options.tokenOptions.stashName);
	}

	get stashNumber(): string {
		return this._padOrTruncate(this._item.number ?? '', this._options.tokenOptions.stashNumber);
	}

	get stashOnRef(): string {
		return this._padOrTruncate(this._item.stashOnRef ?? '', this._options.tokenOptions.stashOnRef);
	}

	get tips(): string {
		let branchAndTagTips = this._options.getBranchAndTagTips?.(this._item.sha, { icons: this._options.markdown });
		if (branchAndTagTips != null && this._options.markdown) {
			const tips = branchAndTagTips.split(', ');
			branchAndTagTips = tips
				.map(t => `<span style="color:#ffffff;background-color:#1d76db;">&nbsp;&nbsp;${t}&nbsp;&nbsp;</span>`)
				.join(GlyphChars.Space.repeat(3));
		}
		return this._padOrTruncate(branchAndTagTips ?? '', this._options.tokenOptions.tips);
	}

	static fromTemplate(template: string, commit: GitCommit, dateFormat: string | null): string;
	static fromTemplate(template: string, commit: GitCommit, options?: CommitFormatOptions): string;
	static fromTemplate(
		template: string,
		commit: GitCommit,
		dateFormatOrOptions?: string | null | CommitFormatOptions,
	): string;
	static fromTemplate(
		template: string,
		commit: GitCommit,
		dateFormatOrOptions?: string | null | CommitFormatOptions,
	): string {
		if (dateFormatOrOptions == null || typeof dateFormatOrOptions === 'string') {
			dateFormatOrOptions = {
				dateFormat: dateFormatOrOptions,
			};
		}

		if (CommitFormatter.has(template, 'footnotes')) {
			if (dateFormatOrOptions.footnotes == null) {
				dateFormatOrOptions.footnotes = new Map<number, string>();
			}
		}

		if (CommitFormatter.has(template, 'avatar') && dateFormatOrOptions?.markdown) {
			debugger;
			throw new Error("Invalid template token 'avatar' used in non-async call");
		}

		return super.fromTemplateCore(this, template, commit, dateFormatOrOptions);
	}

	static fromTemplateAsync(template: string, commit: GitCommit, dateFormat: string | null): Promise<string>;
	static fromTemplateAsync(template: string, commit: GitCommit, options?: CommitFormatOptions): Promise<string>;
	static fromTemplateAsync(
		template: string,
		commit: GitCommit,
		dateFormatOrOptions?: string | null | CommitFormatOptions,
	): Promise<string>;
	static fromTemplateAsync(
		template: string,
		commit: GitCommit,
		dateFormatOrOptions?: string | null | CommitFormatOptions,
	): Promise<string> {
		if (CommitFormatter.has(template, 'footnotes')) {
			if (dateFormatOrOptions == null || typeof dateFormatOrOptions === 'string') {
				dateFormatOrOptions = {
					dateFormat: dateFormatOrOptions,
				};
			}

			if (dateFormatOrOptions.footnotes == null) {
				dateFormatOrOptions.footnotes = new Map<number, string>();
			}
		}

		return super.fromTemplateCoreAsync(this, template, commit, dateFormatOrOptions);
	}

	static override has(
		template: string,
		...tokens: (keyof NonNullable<CommitFormatOptions['tokenOptions']>)[]
	): boolean {
		return super.has<CommitFormatOptions>(template, ...tokens);
	}
}

function getMarkdownActionCommand<T extends ActionContext>(action: Action<T>, args: Omit<T, 'type'>): string {
	return Command.getMarkdownCommandArgsCore(`${Commands.ActionPrefix}${action}`, {
		...args,
		type: action,
	});
}
