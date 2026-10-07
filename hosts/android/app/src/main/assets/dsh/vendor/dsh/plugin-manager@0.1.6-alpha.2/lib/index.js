import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import z from "@deepseek-ai/schemastery";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { pluginEntryId, readPluginInventory } from "@deepseek-ai/dsh-host-plugin-inventory";
import { OPTIONAL_BUNDLES, composeEntries, loadOptionalPatches, loadOverlayPatches, readProfileManifest, readProfilePatches, reconcileProfilePatches, resolveBundleDir, resolveProfileDir } from "@deepseek-ai/dsh-app-boot";
import { execa } from "execa";
import { scrubbedParentEnv } from "@deepseek-ai/dsh-subprocess";
import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument, visit } from "yaml";
//#region lib/types/operations.js
/** Resolve relative package specs against the caller's directory.
* @param argument One pnpm argument.
* @param cwd Invocation directory, never the profile directory.
* @returns Anchored argument.
*/
function anchorPathSpec(argument, cwd) {
	const match = /^(?<prefix>(?:file|link):)?(?<path>\.{1,2}(?:[/\\].*)?)$/.exec(argument);
	if (match?.groups?.path === void 0) return argument;
	return `${match.groups.prefix ?? ""}${resolve(cwd, match.groups.path)}`;
}
/** Read bundle metadata without loading its JavaScript.
* @param name Installed dependency or installation-owned package name.
* @param dir Profile directory.
* @param anchor Installation manifest.
* @returns Resolved metadata, or undefined for packages without bundle metadata.
*/
function bundleManifest(name, dir, anchor) {
	const manifest = readProfileManifest("dsh", resolveBundleDir("dsh", name, anchor, dir));
	return manifest.dsh?.bundle?.patch === void 0 ? void 0 : manifest;
}
/** Atomically save a profile manifest while retaining unrelated fields.
* @param dir Profile directory.
* @param manifest Updated document.
*/
async function saveManifest(dir, manifest) {
	await writeFileAtomic(join(dir, "package.json"), JSON.stringify(manifest, void 0, 2) + "\n", { mode: 384 });
}
/** Reconcile package removals and newly installed bundles without re-enabling retained dependencies. */
async function reconcile(before, dir, anchor, options) {
	const after = readProfileManifest("dsh", dir);
	const dependencies = Object.keys(after.dependencies ?? {});
	const beforeDeps = new Set(Object.keys(before.dependencies ?? {}));
	const previous = after.dsh?.profile?.bundles ?? [];
	const bundles = previous.filter((name) => {
		if (!beforeDeps.has(name) && !dependencies.includes(name)) return true;
		return dependencies.includes(name) && bundleManifest(name, dir, anchor) !== void 0;
	});
	for (const name of dependencies) {
		if (beforeDeps.has(name)) continue;
		const metadata = bundleManifest(name, dir, anchor);
		if (metadata?.dsh?.bundle === void 0) {
			options.onOutput?.(`dsh: warning: ${name} declares no dsh.bundle — installed as a plain dependency, not a profile layer\n`, "stderr");
			continue;
		}
		loadOverlayPatches("dsh", join(resolveBundleDir("dsh", name, anchor, dir), metadata.dsh.bundle.patch));
		if (!bundles.includes(name)) bundles.push(name);
	}
	if (JSON.stringify(previous) === JSON.stringify(bundles)) return;
	after.dsh = {
		...after.dsh,
		profile: {
			...after.dsh?.profile,
			bundles
		}
	};
	await saveManifest(dir, after);
}
/** Execute pnpm inside a profile whose caller already holds the profile write lock.
* @param context Launcher-owned profile and resolution locations.
* @param args Pnpm arguments, before relative path anchoring.
* @param options Output, activation and cancellation policy.
* @returns Exit status and diagnostic path; service output is bounded, CLI output uses inherited descriptors.
*/
async function runProfilePnpm(context, args, options) {
	const dir = context.dir ?? resolveProfileDir(context.profile, context.home);
	const before = readProfileManifest("dsh", dir);
	const logRoot = join(dir, ".plugin-manager", "logs");
	await mkdir(logRoot, {
		recursive: true,
		mode: 448
	});
	const logPath = join(await mkdtemp(join(logRoot, "operation-")), "pnpm.log");
	const log = await open(logPath, "wx", 384);
	let output = Buffer.alloc(0);
	let truncated = false;
	const cancellation = new AbortController();
	const child = execa(options.command ?? "pnpm", [...options.args ?? [], ...args.map((arg) => anchorPathSpec(arg, context.cwd))], {
		cwd: dir,
		env: {
			...options.execution === "cli" ? process.env : scrubbedParentEnv(),
			...options.env
		},
		extendEnv: false,
		reject: false,
		stdout: options.execution === "cli" ? "inherit" : "pipe",
		stderr: options.execution === "cli" ? "inherit" : "pipe",
		buffer: false,
		stdin: options.execution === "cli" ? "inherit" : "ignore",
		cancelSignal: options.signal === void 0 ? cancellation.signal : AbortSignal.any([cancellation.signal, options.signal])
	});
	let writes = Promise.resolve();
	const collect = async (stream, kind) => {
		try {
			for await (const chunk of stream) {
				const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				writes = writes.then(async () => {
					await log.write(bytes);
				});
				await writes;
				options.onOutput?.(bytes.toString("utf8"), kind);
				output = Buffer.concat([output, bytes]);
				if (output.length > options.outputBytes) {
					truncated = true;
					output = output.subarray(output.length - options.outputBytes);
				}
			}
		} catch (error) {
			cancellation.abort();
			throw error;
		}
	};
	let exitCode;
	try {
		const [completion, ...streams] = await Promise.allSettled([
			child,
			...child.stdout === null ? [] : [collect(child.stdout, "stdout")],
			...child.stderr === null ? [] : [collect(child.stderr, "stderr")]
		]);
		for (const stream of streams) if (stream.status === "rejected") throw stream.reason;
		if (completion.status === "rejected") throw completion.reason;
		const result = completion.value;
		exitCode = result.exitCode ?? (result.code === "ENOENT" ? 127 : 1);
		if (result.failed && output.length === 0) {
			const diagnostic = result.shortMessage ?? "pnpm failed";
			await log.write(diagnostic);
			truncated = Buffer.byteLength(diagnostic) > options.outputBytes;
			output = Buffer.from(diagnostic).subarray(0, options.outputBytes);
		}
		if (exitCode === 0 && options.activateNewBundles !== false) await reconcile(before, dir, context.installAnchor, options);
	} finally {
		await log.close();
	}
	return {
		exitCode,
		output: output.toString("utf8"),
		truncated,
		logPath
	};
}
/**
* Ask the registry what a spec names through `pnpm view`, run in the profile
* directory so the registry, proxy, and authentication settings of an install apply.
* @param dir Profile directory.
* @param spec One registry spec: a package name with an optional range.
* @param options Cancellation and the time bound.
* @returns pnpm's exit, output, and how the lookup ended.
*/
async function viewProfilePackage(dir, spec, options) {
	const result = await execa(options.command ?? "pnpm", [
		...options.args ?? [],
		"view",
		spec,
		"name",
		"version",
		"description",
		"dsh",
		"--json"
	], {
		cwd: dir,
		env: {
			...scrubbedParentEnv(),
			...options.env
		},
		extendEnv: false,
		reject: false,
		stdin: "ignore",
		timeout: options.timeoutMs,
		...options.signal === void 0 ? {} : { cancelSignal: options.signal }
	});
	const cause = result.exitCode === void 0 && !result.timedOut && !result.isCanceled ? Object.assign(new Error(result.shortMessage), { code: result.code }) : void 0;
	return {
		exitCode: result.exitCode ?? null,
		stdout: result.stdout,
		stderr: result.stderr,
		timedOut: result.timedOut,
		...cause === void 0 ? {} : { cause }
	};
}
//#endregion
//#region lib/types/install-failure.js
/**
* What a failed pnpm run was, read off how it ended and what it printed:
* pnpm names its failures with stable `ERR_PNPM_*` codes and Node's errno
* names, which the run's captured tail carries whatever the locale.
* @module @deepseek-ai/dsh-plugin-manager/install-failure
*/
/** Patterns in the order they decide: a specific code before the generic network family. */
const LOG_KINDS = [
	["build-blocked", /ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/],
	["not-found", /ERR_PNPM_FETCH_404|\bE404\b|404 Not Found|Not Found - GET/],
	["no-matching-version", /ERR_PNPM_NO_MATCHING_VERSION|\bETARGET\b|No matching version/],
	["disk-full", /\bENOSPC\b|no space left on device/i],
	["permission", /\bEACCES\b|\bEPERM\b|permission denied/i],
	["integrity", /ERR_PNPM_TARBALL_INTEGRITY|ERR_PNPM_BAD_TARBALL_SIZE|\bEINTEGRITY\b/],
	["network", /\bENOTFOUND\b|\bECONNRESET\b|\bETIMEDOUT\b|\bECONNREFUSED\b|\bEAI_AGAIN\b|ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_FETCH_5\d\d|ERR_PNPM_FETCH_TIMEOUT|socket hang up|Could not resolve host|unable to access/]
];
/**
* Classify a failed run.
* @param facts - how the run ended and what it printed.
* @returns the kind, `unknown` when nothing in the facts names one.
*/
function classifyInstallFailure(facts) {
	if (facts.timedOut === true) return "timeout";
	if (facts.cause?.code === "ENOENT") return "pnpm-missing";
	for (const [kind, pattern] of LOG_KINDS) if (pattern.test(facts.log)) return kind;
	return "unknown";
}
//#endregion
//#region lib/types/install-spec.js
/**
* Reading an install spec before pnpm sees it: which of pnpm's spec forms it
* takes, and for a registry name whether it is one the registry can accept.
* @module @deepseek-ai/dsh-plugin-manager/install-spec
*/
/** The forms pnpm resolves through a git host: a host shorthand, a git URL, or a hosted repository URL. */
const GIT_SHORTHAND = /^(?:github|gitlab|bitbucket|gist):/i;
const GIT_URL = /^git(?:\+[a-z]+)?:\/\/|^git@[^:]+:/i;
const HOSTED_REPOSITORY_URL = /^https?:\/\/[^/]+\/[^/]+\/[^/#]+(?:\.git)?(?:#.*)?$/i;
/** A tarball, on disk or over HTTP. */
const TARBALL_SPEC = /\.(?:tgz|tar\.gz)(?:#.*)?$/i;
/** An npm package name: lowercase URL-safe segments, an optional scope, no leading dot or underscore. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const PACKAGE_NAME_MAX_LENGTH = 214;
/** A spec neither pnpm nor the registry would take; `reason` is what the person reads. */
var InvalidInstallSpecError = class extends Error {
	spec;
	reason;
	/**
	* @param spec - the spec as typed, trimmed.
	* @param reason - why it is refused, as one sentence.
	*/
	constructor(spec, reason) {
		super(`plugin-manager: ${reason}: ${spec}`);
		this.spec = spec;
		this.reason = reason;
		this.name = "InvalidInstallSpecError";
	}
};
function invalid(spec, reason) {
	return new InvalidInstallSpecError(spec, reason);
}
/**
* Read a spec into its form. A path must be absolute: the Host's working
* directory means nothing to the person typing into a browser, and a
* relative path resolved against the profile would point inside it.
* @param raw - the spec as typed.
* @returns the parsed spec.
* @throws {InvalidInstallSpecError} for an empty spec, a relative path, a name the
* registry would refuse, or a URL that is neither a git host nor a tarball.
*/
function parseInstallSpec(raw) {
	const spec = raw.trim();
	if (spec === "") throw invalid(spec, "the package spec must not be empty");
	const path = spec.replace(/^(?:file|link):/, "");
	if (path !== spec || isAbsolute(path)) {
		if (!isAbsolute(path)) throw invalid(spec, "a local path must be absolute");
		return TARBALL_SPEC.test(path) ? {
			kind: "tarball",
			spec,
			path
		} : {
			kind: "path",
			spec,
			path
		};
	}
	if (/^\.{1,2}(?:[\\/]|$)/.test(spec)) throw invalid(spec, "a local path must be absolute");
	if ((GIT_SHORTHAND.test(spec) || GIT_URL.test(spec) || HOSTED_REPOSITORY_URL.test(spec)) && !TARBALL_SPEC.test(spec)) return {
		kind: "git",
		spec
	};
	if (/^https?:\/\//i.test(spec)) {
		if (TARBALL_SPEC.test(spec)) return {
			kind: "tarball",
			spec
		};
		throw invalid(spec, "a URL must point at a git repository or a tarball");
	}
	const at = spec.indexOf("@", 1);
	const name = at === -1 ? spec : spec.slice(0, at);
	const range = at === -1 ? void 0 : spec.slice(at + 1);
	if (name.length > PACKAGE_NAME_MAX_LENGTH || !PACKAGE_NAME.test(name)) throw invalid(spec, "not a package name the registry accepts");
	if (range === "") throw invalid(spec, "a version after @ must not be empty");
	return range === void 0 ? {
		kind: "registry",
		spec,
		name
	} : {
		kind: "registry",
		spec,
		name,
		range
	};
}
//#endregion
//#region lib/types/patch.js
/** Comment-preserving profile plugin enablement edits. */
/** Replace the last matching override or append one after existing insertions.
* @param filename Current profile patch file.
* @param id Unique composition entry id.
* @param name Module name used to match name-qualified overrides.
* @param enabled Desired entry enablement.
* @returns Whether the file changed.
*/
async function writePluginEnabled(filename, id, name, enabled) {
	let text;
	try {
		text = await readFile(filename, "utf8");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		text = "[]\n";
	}
	const document = parseDocument(text, { customTags: [{
		tag: "tag:yaml.org,2002:js",
		resolve: (value) => value
	}] });
	const error = document.errors[0];
	if (error !== void 0) throw error;
	if (!isSeq(document.contents)) throw new Error("Profile patch must be a YAML sequence");
	loadOptionalPatches("dsh", filename);
	const items = document.contents.items;
	const target = items.findLast((item, index) => {
		if (!isMap(item) || document.getIn([index, "id"]) !== id || item.has("insert")) return false;
		const expectedName = document.getIn([index, "name"]);
		return !expectedName || expectedName === name;
	});
	if (isMap(target)) {
		if (document.getIn([items.indexOf(target), "disabled"]) === !enabled) return false;
		document.setIn([items.indexOf(target), "disabled"], !enabled);
	} else document.add({
		id,
		disabled: !enabled
	});
	await writeFileAtomic(filename, String(document), { mode: 384 });
	return true;
}
//#endregion
//#region lib/types/failure.js
/** Expected management rejection; presentation belongs to the caller's locale. */
var ManagementFailure = class extends Error {
	/** Code rendered by the caller's locale dictionary. */
	code;
	/** @param code Localizable management rejection. */
	constructor(code) {
		super(code);
		this.code = code;
	}
};
//#endregion
//#region lib/types/build-approval.js
/** Approve pnpm's pending dependency scripts in the current profile's workspace settings. */
async function readPolicy(dir) {
	let text;
	try {
		text = await readFile(join(dir, "pnpm-workspace.yaml"), "utf8");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		text = "{}\n";
	}
	const document = parseDocument(text);
	if (document.errors[0] !== void 0) throw document.errors[0];
	if (!isMap(document.contents)) throw new Error("pnpm-workspace.yaml must be a YAML mapping");
	const builds = document.get("allowBuilds");
	if (builds !== void 0 && !isMap(builds)) throw new Error("allowBuilds must be a YAML mapping");
	visit(builds ?? null, (_key, node) => {
		if (isAlias(node) || isNode(node) && "anchor" in node && node.anchor) throw new Error("allowBuilds must not contain YAML anchors or aliases");
	});
	return {
		document,
		pending: isMap(builds) ? builds.items.flatMap(({ key, value }) => isScalar(key) && typeof key.value === "string" && !/[*?]/.test(key.value) && isScalar(value) && value.value === "set this to true or false" ? [key.value] : []) : []
	};
}
/** Read package names left undecided by pnpm 11, including after installation cleanup.
* @param dir Current profile directory.
* @returns Exact package names awaiting a build decision; wildcard rules are excluded.
*/
async function readPendingBuilds(dir) {
	return (await readPolicy(dir)).pending;
}
/** Persist approval without running scripts; the caller holds the profile manifest lock.
* @param dir Current profile directory.
* @param names Explicit package names from the pending build list.
* @throws If a name is no longer pending or allowBuilds contains YAML anchors or aliases; no approvals are written.
*/
async function approveBuilds(dir, names) {
	const { document, pending } = await readPolicy(dir);
	if (names.some((name) => !pending.includes(name))) throw new ManagementFailure("stale-approval");
	if (names.length === 0) return;
	for (const name of names) document.setIn(["allowBuilds", name], true);
	await writeFileAtomic(join(dir, "pnpm-workspace.yaml"), String(document), { mode: 384 });
}
//#endregion
//#region lib/types/index.js
/** Current-profile plugin and bundle management over shared dsh plugin operations. */
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
const protectedModules = new Set([
	"@deepseek-ai/dsh-plugin-manager",
	"@deepseek-ai/cordis-plugin-loader",
	"@deepseek-ai/cordis-plugin-include",
	"@deepseek-ai/dsh-api-gateway",
	"@deepseek-ai/dsh-host-webserver",
	"@deepseek-ai/dsh-client-modules",
	"@deepseek-ai/dsh-client-ui-settings-plugin-inventory",
	"@deepseek-ai/dsh-client-ui-plugin-manager",
	"@deepseek-ai/dsh-host-plugin-inventory",
	"@deepseek-ai/dsh-typert-registry",
	"@deepseek-ai/dsh-api-remotes",
	"@deepseek-ai/cordis-plugin-timer",
	"@deepseek-ai/dsh-client-connection",
	"@deepseek-ai/dsh-host-frontend-static",
	"@deepseek-ai/dsh-tools",
	"@deepseek-ai/dsh-hmr"
]);
/** The profile files an installation writes and a failed or cancelled one restores. */
const RESTORED_FILES = ["package.json", "pnpm-lock.yaml"];
/** pnpm's colour escapes, which a JSON answer may be wrapped in. */
const ANSI_SEQUENCE = /\x1b\[[0-9;]*m/g;
/** Flatten only the groups addressable by the profile's patch composer. */
function flatten(rows) {
	return rows.flatMap((row) => [row, ...row.group && Array.isArray(row.config) ? flatten(row.config) : []]);
}
/** Preserve the exact observed diagnostic, including non-Error failures. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
/** An expected refusal keeps its code; anything else becomes an operation error carrying its exact diagnostic. */
function managementError(error) {
	return error instanceof ManagementFailure ? { code: error.code } : {
		code: "operation-error",
		diagnostic: messageOf(error)
	};
}
/** The caller stopped an installation; its files are restored before this is thrown. */
var InstallCancelledError = class extends Error {
	constructor() {
		super("Installation cancelled");
		this.name = "InstallCancelledError";
	}
};
/** A manifest field that is a string, when the manifest carries one. */
function stringField(manifest, field) {
	const value = manifest[field];
	return typeof value === "string" ? value : void 0;
}
/** What a package manifest says about the package: identity, one-liner, and whether it is a bundle. */
function inspectionOf(kind, manifest) {
	const dsh = manifest.dsh;
	const declared = typeof dsh === "object" && dsh !== null ? dsh : void 0;
	const bundle = declared !== void 0 && typeof declared.bundle === "object" && declared.bundle !== null;
	const name = stringField(manifest, "name");
	const version = stringField(manifest, "version");
	const description = stringField(manifest, "description");
	return {
		status: "accepted",
		kind,
		bundle,
		...name === void 0 ? {} : { name },
		...version === void 0 ? {} : { version },
		...description === void 0 || description === "" ? {} : { description }
	};
}
function refused(problem, reason) {
	return {
		status: "refused",
		problem,
		reason
	};
}
/** Manage profile files and apply their declared reload lifecycle. */
let PluginManager = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _listPlugins_decorators;
	let _listBundles_decorators;
	let _inspect_decorators;
	let _setPluginEnabled_decorators;
	let _setBundleEnabled_decorators;
	let _installBundle_decorators;
	let _cancelInstall_decorators;
	let _removeBundle_decorators;
	return class PluginManager extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_listPlugins_decorators = [Remote];
			_listBundles_decorators = [Remote];
			_inspect_decorators = [Remote];
			_setPluginEnabled_decorators = [Remote];
			_setBundleEnabled_decorators = [Remote];
			_installBundle_decorators = [Remote];
			_cancelInstall_decorators = [Remote];
			_removeBundle_decorators = [Remote];
			__esDecorate(this, null, _listPlugins_decorators, {
				kind: "method",
				name: "listPlugins",
				static: false,
				private: false,
				access: {
					has: (obj) => "listPlugins" in obj,
					get: (obj) => obj.listPlugins
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _listBundles_decorators, {
				kind: "method",
				name: "listBundles",
				static: false,
				private: false,
				access: {
					has: (obj) => "listBundles" in obj,
					get: (obj) => obj.listBundles
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _inspect_decorators, {
				kind: "method",
				name: "inspect",
				static: false,
				private: false,
				access: {
					has: (obj) => "inspect" in obj,
					get: (obj) => obj.inspect
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _setPluginEnabled_decorators, {
				kind: "method",
				name: "setPluginEnabled",
				static: false,
				private: false,
				access: {
					has: (obj) => "setPluginEnabled" in obj,
					get: (obj) => obj.setPluginEnabled
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _setBundleEnabled_decorators, {
				kind: "method",
				name: "setBundleEnabled",
				static: false,
				private: false,
				access: {
					has: (obj) => "setBundleEnabled" in obj,
					get: (obj) => obj.setBundleEnabled
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _installBundle_decorators, {
				kind: "method",
				name: "installBundle",
				static: false,
				private: false,
				access: {
					has: (obj) => "installBundle" in obj,
					get: (obj) => obj.installBundle
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _cancelInstall_decorators, {
				kind: "method",
				name: "cancelInstall",
				static: false,
				private: false,
				access: {
					has: (obj) => "cancelInstall" in obj,
					get: (obj) => obj.cancelInstall
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _removeBundle_decorators, {
				kind: "method",
				name: "removeBundle",
				static: false,
				private: false,
				access: {
					has: (obj) => "removeBundle" in obj,
					get: (obj) => obj.removeBundle
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		static inject = ["loader", "profileContext"];
		static Config = z.object({
			pnpmCommand: z.string().default("pnpm"),
			outputBytes: z.number().step(1).min(1).default(16384),
			lockWaitMs: z.number().step(1).min(0).default(12e4),
			inspectTimeoutMs: z.number().step(1).min(1e3).default(2e4)
		});
		ownerEntryId = __runInitializers(this, _instanceExtraInitializers);
		packageOperations = /* @__PURE__ */ new Set();
		profile;
		outputBytes;
		lockWaitMs;
		inspectTimeoutMs;
		pnpmCommand;
		ownerContext;
		abort = new AbortController();
		/** Installations by request id, from their call until it settles. */
		installs = /* @__PURE__ */ new Map();
		constructor(ctx, config) {
			super(ctx, "pluginManager");
			this.ownerEntryId = ctx.fiber.entry?.id;
			this.ownerContext = ctx;
			this.profile = ctx.profileContext;
			this.outputBytes = config.outputBytes;
			this.lockWaitMs = config.lockWaitMs;
			this.inspectTimeoutMs = config.inspectTimeoutMs;
			this.pnpmCommand = config.pnpmCommand;
			ctx.effect(() => async () => {
				this.abort.abort();
				await Promise.allSettled([...this.packageOperations]);
			}, "plugin-manager: package cancellation");
		}
		/** Read current plugins, including why a row cannot be changed through the profile patch.
		* @returns Current runtime entries with persistent patch targets.
		*/
		async listPlugins() {
			const rows = flatten(composeEntries([readProfilePatches("dsh", this.profile)]));
			return (await readPluginInventory(this.ctx)).entries.map((entry) => {
				const actual = [...this.ctx.loader.entries()].find((row) => row.id === entry.entryId);
				const candidates = rows.filter((row) => row.id === actual?.options.id);
				const candidate = candidates[0];
				if (protectedModules.has(entry.moduleName) || entry.entryId === this.ownerEntryId) return {
					...entry,
					readOnlyReason: "management-required"
				};
				if (candidate === void 0 || candidates.length > 1 || candidate.name !== entry.moduleName || actual?.parent.tree.ctx.fiber.entry?.id !== "include") return {
					...entry,
					readOnlyReason: "unaddressable"
				};
				return {
					...entry,
					patchId: candidate.id
				};
			});
		}
		/** Read the profile's installed bundles, the bundles this dsh installation supplies, and the selected names that are not bundles.
		* A dependency without a bundle patch is listed, as a `not-bundle` problem, only while it is selected.
		* @returns Package versions, one-liners, rows, activation selections, whether the installation offers the
		* bundle, and removal availability.
		*/
		listBundles() {
			const manifest = readProfileManifest("dsh", this.profile.dir);
			const selected = manifest.dsh?.profile?.bundles ?? [];
			const dependencies = Object.keys(manifest.dependencies ?? {});
			const installation = JSON.parse(readFileSync(this.profile.installAnchor, "utf8"));
			const names = [...new Set([
				...selected,
				...dependencies,
				...Object.keys(installation.dependencies ?? {})
			])];
			const bundles = [];
			for (const name of names) {
				const installed = dependencies.includes(name);
				const optional = OPTIONAL_BUNDLES.includes(name);
				const removable = installed && !Object.hasOwn(installation.dependencies ?? {}, name);
				const enabled = selected.includes(name);
				try {
					const info = bundleManifest(name, this.profile.dir, this.profile.installAnchor);
					if (info === void 0) {
						if (enabled) bundles.push({
							name,
							enabled,
							installed,
							optional,
							removable,
							error: { code: "not-bundle" },
							rows: [],
							overrides: []
						});
						continue;
					}
					const readOnlyReason = this.protectsManager(name) ? "management-required" : void 0;
					bundles.push({
						name,
						...info.version === void 0 ? {} : { version: info.version },
						...info.description === void 0 || info.description === "" ? {} : { description: info.description },
						enabled,
						installed,
						optional,
						removable: removable && readOnlyReason === void 0,
						...readOnlyReason === void 0 ? {} : { readOnlyReason },
						...this.declaredRows(name, info)
					});
				} catch (error) {
					if (enabled || installed) bundles.push({
						name,
						enabled,
						installed,
						optional,
						removable,
						error: managementError(error),
						rows: [],
						overrides: []
					});
				}
			}
			return Promise.resolve(bundles);
		}
		/** Read what a spec names before installing it.
		* @param spec One package spec: a registry name, an absolute path, a git address, or a tarball.
		* @param signal Ends a registry lookup early.
		* @returns The package the spec names, or why it is refused.
		*/
		async inspect(spec, signal) {
			let parsed;
			try {
				parsed = parseInstallSpec(spec);
			} catch (error) {
				/* v8 ignore next 2 -- parseInstallSpec throws nothing but its own refusal */
				if (!(error instanceof InvalidInstallSpecError)) throw error;
				return refused("invalid-spec", error.reason);
			}
			const manifest = readProfileManifest("dsh", this.profile.dir);
			const installation = JSON.parse(readFileSync(this.profile.installAnchor, "utf8"));
			const known = new Set([
				...manifest.dsh?.profile?.bundles ?? [],
				...Object.keys(manifest.dependencies ?? {}),
				...Object.keys(installation.dependencies ?? {})
			]);
			switch (parsed.kind) {
				case "git": return {
					status: "accepted",
					kind: "git",
					bundle: null
				};
				case "tarball":
					if (parsed.path !== void 0 && !existsSync(parsed.path)) return refused("not-a-package", "the tarball does not exist");
					return {
						status: "accepted",
						kind: "tarball",
						bundle: null
					};
				case "path": {
					if (!existsSync(parsed.path)) return refused("not-a-package", "the path does not exist");
					let read;
					try {
						read = JSON.parse(await readFile(join(parsed.path, "package.json"), "utf8"));
					} catch (error) {
						return refused("not-a-package", `no readable package.json at the path: ${messageOf(error)}`);
					}
					const inspection = inspectionOf("path", read);
					if (inspection.name === void 0) return refused("not-a-package", "the package.json names no package");
					if (known.has(inspection.name)) return refused("already-installed", `${inspection.name} is already installed`);
					if (!inspection.bundle) return refused("not-a-bundle", `${inspection.name} declares no dsh.bundle`);
					return inspection;
				}
				case "registry": {
					if (known.has(parsed.name)) return refused("already-installed", `${parsed.name} is already installed`);
					const view = await viewProfilePackage(this.profile.dir, spec.trim(), {
						...this.profile.packageManager ?? { command: this.pnpmCommand },
						timeoutMs: this.inspectTimeoutMs,
						...signal === void 0 ? {} : { signal }
					});
					const log = `${view.stderr}${view.cause === void 0 ? "" : `${messageOf(view.cause)}\n`}`.trim();
					if (view.exitCode !== 0 || view.cause !== void 0 || view.timedOut) {
						const kind = classifyInstallFailure({
							log,
							timedOut: view.timedOut,
							...view.cause === void 0 ? {} : { cause: view.cause }
						});
						const reason = log || view.stdout.trim() || `pnpm view exited with ${String(view.exitCode)}`;
						if (kind === "not-found" || kind === "no-matching-version") return refused("not-found", reason);
						if (kind === "network") return refused("network", reason);
						return refused("unknown", view.timedOut ? `pnpm view timed out after ${String(this.inspectTimeoutMs)}ms` : reason);
					}
					let answer;
					try {
						answer = JSON.parse(view.stdout.replace(ANSI_SEQUENCE, "").trim() || "null");
					} catch (error) {
						return refused("unknown", `unreadable pnpm view output: ${messageOf(error)}`);
					}
					const latest = Array.isArray(answer) ? answer.at(-1) : answer;
					if (typeof latest !== "object" || latest === null) return refused("unknown", "pnpm view answered no package");
					const inspection = inspectionOf("registry", latest);
					const named = inspection.name === void 0 ? {
						...inspection,
						name: parsed.name
					} : inspection;
					if (!named.bundle) return refused("not-a-bundle", `${named.name} declares no dsh.bundle`);
					return named;
				}
			}
		}
		/** Persist a plugin entry's desired enablement and apply it on live profiles.
		* @param id Loader entry identity returned by listPlugins.
		* @param enabled Whether the plugin should run.
		* @returns Saved and runtime outcomes, including higher-priority overrides.
		*/
		setPluginEnabled(id, enabled) {
			return this.change((result) => this.configure(async () => {
				const row = (await this.listPlugins()).find((item) => item.entryId === id);
				if (row === void 0) throw new ManagementFailure("unknown-plugin");
				if (row.readOnlyReason !== void 0) throw new ManagementFailure(row.readOnlyReason);
				await writePluginEnabled(this.profile.patchPath, row.patchId, row.moduleName, enabled);
				result.warnings = await this.reload(enabled ? [row.patchId] : []);
				return (await this.listPlugins()).find((item) => item.entryId === id)?.enabled !== enabled && this.ownerContext.get("hmr") !== void 0 ? "overridden" : void 0;
			}), {
				stage: "enable",
				target: id,
				enabled
			}, "plugin");
		}
		/** Select or remove a bundle layer while retaining installed dependencies.
		* @param name Bundle package name.
		* @param enabled Whether the bundle contributes its patch layer.
		* @returns Persisted and runtime outcomes.
		*/
		setBundleEnabled(name, enabled) {
			return this.change((result) => this.configure(async () => {
				await this.selectBundle(name, enabled);
				result.warnings = await this.reload(enabled ? this.bundleRows(name).map((row) => row.id) : []);
			}), {
				stage: "enable",
				target: name,
				enabled
			}, "bundle");
		}
		/**
		* Install a package using the same pnpm implementation as dsh plugin. A run
		* that fails, is cancelled, or adds a package without a bundle patch restores
		* `package.json` and `pnpm-lock.yaml` as they were; downloaded files can stay.
		* @param spec One package spec, including local paths relative to the invocation directory.
		* @param options Whether to activate the installed bundle (defaults to true), the request id a cancellation names, and
		* the pending build scripts to allow for this profile before pnpm runs.
		* @returns Package-manager diagnostics and observed activation outcome.
		*/
		installBundle(spec, options) {
			const requestId = options?.requestId;
			const control = {
				abort: new AbortController(),
				phase: "installing",
				settled: Promise.resolve()
			};
			const stopped = () => control.abort.signal.aborted;
			if (requestId !== void 0) this.installs.set(requestId, control);
			const announce = (phase) => {
				if (requestId !== void 0) this.ownerContext.emit("plugin-manager/install-state", {
					requestId,
					phase
				});
			};
			const result = this.change(async (result) => {
				if (spec.trim() === "" || spec.startsWith("-")) throw new ManagementFailure("invalid-spec");
				if (stopped()) throw new InstallCancelledError();
				if (options?.approvedBuilds !== void 0) {
					await approveBuilds(this.profile.dir, options.approvedBuilds);
					result.approvedBuilds = options.approvedBuilds;
				}
				const files = await this.readRestoredFiles();
				const before = readProfileManifest("dsh", this.profile.dir).dependencies ?? {};
				announce("installing");
				let name;
				try {
					result.packageResult = await this.runPnpm(["add", spec], control.abort.signal, requestId);
					if (stopped()) throw new InstallCancelledError();
					if (result.packageResult.exitCode !== 0) {
						try {
							result.pendingBuilds = await readPendingBuilds(this.profile.dir);
						} catch (error) {
							this.ownerContext.logger.warn("Could not read pending build approvals after pnpm failed", error);
						}
						throw new Error(result.packageResult.output);
					}
					const after = readProfileManifest("dsh", this.profile.dir).dependencies ?? {};
					const installed = Object.keys(after).filter((name) => before[name] !== after[name]);
					if (installed.length === 0) installed.push(...Object.keys(after).filter((name) => spec === name || spec.startsWith(`${name}@`)));
					const target = installed[0];
					if (installed.length !== 1 || target === void 0) throw new ManagementFailure("ambiguous-install");
					name = target;
					const dir = resolveBundleDir("dsh", name, this.profile.installAnchor, this.profile.dir);
					const manifest = bundleManifest(name, this.profile.dir, this.profile.installAnchor);
					if (manifest?.dsh?.bundle?.patch === void 0) throw new ManagementFailure("not-bundle");
					loadOverlayPatches("dsh", join(dir, manifest.dsh.bundle.patch));
				} catch (error) {
					await this.restoreFiles(files);
					throw error;
				}
				control.phase = "applying";
				announce("applying");
				result.bundle = name;
				result.target = name;
				result.stage = "enable";
				return this.configure(async () => {
					if (options?.enabled !== false) await this.selectBundle(name, true);
					if (Object.hasOwn(before, name)) return "restart-required";
					if (options?.enabled !== false) result.warnings = await this.reload();
				});
			}, {
				stage: "install",
				target: spec,
				enabled: options?.enabled !== false
			}, "install");
			/* v8 ignore next -- change() folds every failure into its result; only a lock or disposal error rejects */
			control.settled = result.then(() => void 0, () => void 0);
			return result.finally(() => {
				if (requestId !== void 0) this.installs.delete(requestId);
			});
		}
		/** Stop an installation this manager owns and wait until its files are back.
		* @param requestId The id the installation was started with.
		* @returns `cancelled` once pnpm exited and the files are restored, `too-late` once the bundle is being
		* applied, `not-running` for any other id.
		*/
		async cancelInstall(requestId) {
			const control = this.installs.get(requestId);
			if (control === void 0) return { status: "not-running" };
			if (control.phase === "applying") return { status: "too-late" };
			this.ownerContext.emit("plugin-manager/install-state", {
				requestId,
				phase: "cancelling"
			});
			control.abort.abort();
			await control.settled;
			return { status: "cancelled" };
		}
		/** Unload and remove a profile-owned bundle dependency through dsh plugin's pnpm path.
		* @param name Installed dependency name.
		* @returns Removal diagnostics and the remaining profile state.
		*/
		removeBundle(name) {
			return this.change(async (result) => {
				await this.configure(async () => {
					const bundle = (await this.listBundles()).find((item) => item.name === name);
					if (bundle === void 0 || !bundle.removable) throw new ManagementFailure("not-removable");
					if (this.ownerContext.get("hmr") === void 0 && (this.profile.startedBundles.includes(name) || this.bundleRows(name).some((row) => [...this.ctx.loader.entries()].some((entry) => entry.options.id === row.id && entry.fiber !== void 0)))) throw new ManagementFailure("stop-profile");
					const contributions = bundle.error === void 0 ? this.bundleRows(name) : [];
					if (bundle.enabled) {
						await this.selectBundle(name, false);
						result.warnings = await this.reload();
					}
					if ([...this.ctx.loader.entries()].some((entry) => entry.fiber?.uid != null && contributions.some((row) => row.id === entry.options.id && row.name === entry.options.name))) throw new ManagementFailure("bundle-in-use");
				});
				result.packageResult = await this.runPnpm(["remove", name]);
				if (result.packageResult.exitCode !== 0) throw new Error(result.packageResult.output);
			}, {
				stage: "remove",
				target: name
			}, "remove");
		}
		/** The rows a bundle's patch inserts and the existing rows it changes; an unreadable patch throws. */
		declaredRows(name, info) {
			const patch = info.dsh?.bundle?.patch;
			/* v8 ignore next -- bundleManifest answers only manifests that declare a patch */
			if (patch === void 0) return {
				rows: [],
				overrides: []
			};
			const patches = loadOverlayPatches("dsh", join(resolveBundleDir("dsh", name, this.profile.installAnchor, this.profile.dir), patch));
			const live = /* @__PURE__ */ new Map();
			for (const entry of this.ctx.loader.entries())
 /* v8 ignore next -- the Loader gives every entry an id before it is listed */
			if (typeof entry.options.id === "string") live.set(entry.options.id, pluginEntryId(entry.id));
			const rows = [];
			for (const row of flatten(composeEntries([patches.filter((item) => item.insert !== void 0)]))) {
				if (typeof row.id !== "string" || typeof row.name !== "string") continue;
				const entryId = live.get(row.id);
				rows.push({
					rowId: row.id,
					moduleName: row.name,
					...entryId === void 0 ? {} : { entryId }
				});
			}
			const declared = new Set(rows.map((row) => row.rowId));
			return {
				rows,
				overrides: [...new Set(patches.flatMap((item) => item.insert === void 0 && typeof item.id === "string" && !declared.has(item.id) ? [item.id] : []))]
			};
		}
		/** Run one pnpm command in the profile, streaming its output as install-log chunks. */
		async runPnpm(args, signal, requestId) {
			const jobId = randomUUID();
			const argv = ["pnpm", ...args];
			const cwd = this.profile.dir;
			const identity = requestId === void 0 ? {} : { requestId };
			const task = runProfilePnpm({
				...this.profile,
				profile: this.profile.name
			}, args, {
				execution: "service",
				...this.profile.packageManager ?? { command: this.pnpmCommand },
				signal: signal === void 0 ? this.abort.signal : AbortSignal.any([this.abort.signal, signal]),
				outputBytes: this.outputBytes,
				activateNewBundles: false,
				onOutput: (text, stream) => {
					this.ownerContext.emit("plugin-manager/install-log", {
						...identity,
						jobId,
						argv,
						cwd,
						stream,
						text
					});
				}
			});
			this.packageOperations.add(task);
			try {
				const result = await task;
				this.ownerContext.emit("plugin-manager/install-log", {
					...identity,
					jobId,
					argv,
					cwd,
					stream: "stdout",
					text: "",
					exitCode: signal?.aborted === true ? null : result.exitCode
				});
				return result.exitCode === 0 ? result : {
					...result,
					kind: classifyInstallFailure({ log: result.output })
				};
			} catch (error) {
				this.ownerContext.emit("plugin-manager/install-log", {
					...identity,
					jobId,
					argv,
					cwd,
					stream: "stderr",
					text: messageOf(error),
					exitCode: null
				});
				throw error;
			} finally {
				this.packageOperations.delete(task);
			}
		}
		/** The profile files an installation may rewrite, as they are now; absent files read as undefined. */
		async readRestoredFiles() {
			const files = /* @__PURE__ */ new Map();
			for (const name of RESTORED_FILES) {
				const path = join(this.profile.dir, name);
				files.set(path, existsSync(path) ? await readFile(path, "utf8") : void 0);
			}
			return files;
		}
		/** Put the profile files back; pnpm has exited by the time this runs. */
		async restoreFiles(files) {
			for (const [path, content] of files) if (content === void 0) await rm(path, { force: true });
			else await writeFileAtomic(path, content, { mode: 384 });
		}
		async selectBundle(name, enabled) {
			const manifest = readProfileManifest("dsh", this.profile.dir);
			const previous = manifest.dsh?.profile?.bundles ?? [];
			if ((enabled || !previous.includes(name)) && bundleManifest(name, this.profile.dir, this.profile.installAnchor) === void 0) throw new ManagementFailure("not-bundle");
			if (!enabled && previous.includes(name)) {
				if (this.protectsManager(name)) throw new ManagementFailure("management-required");
			}
			const bundles = enabled ? [...previous, ...previous.includes(name) ? [] : [name]] : previous.filter((item) => item !== name);
			if (JSON.stringify(previous) === JSON.stringify(bundles)) return;
			manifest.dsh = {
				...manifest.dsh,
				profile: {
					...manifest.dsh?.profile,
					bundles
				}
			};
			await saveManifest(this.profile.dir, manifest);
		}
		bundleRows(name) {
			const info = bundleManifest(name, this.profile.dir, this.profile.installAnchor);
			if (info?.dsh?.bundle === void 0) return [];
			return flatten(composeEntries([loadOverlayPatches("dsh", join(resolveBundleDir("dsh", name, this.profile.installAnchor, this.profile.dir), info.dsh.bundle.patch))]));
		}
		protectsManager(name) {
			return this.bundleRows(name).some((row) => protectedModules.has(row.name) || `include:${row.id}` === this.ownerEntryId);
		}
		configure(operation) {
			const hmr = this.ownerContext.get("hmr");
			const apply = () => {
				this.abort.signal.throwIfAborted();
				return operation();
			};
			return hmr === void 0 ? apply() : hmr.runExclusive(apply);
		}
		async reload(requiredIds = []) {
			if (this.ownerContext.get("hmr") === void 0) return [];
			return reconcileProfilePatches(this.ownerContext.root, readProfilePatches("dsh", this.profile), "dsh", requiredIds);
		}
		async change(operation, request, reason) {
			return withFileLock(join(this.profile.dir, "package.json"), async () => {
				this.abort.signal.throwIfAborted();
				const before = this.diskState();
				const result = {
					...request,
					changed: false,
					application: this.ownerContext.get("hmr") !== void 0 ? "applied" : "restart-required"
				};
				try {
					result.application = await operation(result) ?? result.application;
				} catch (error) {
					if (error instanceof InstallCancelledError) result.application = "cancelled";
					else {
						result.application = "failed";
						result.error = managementError(error);
					}
				}
				result.changed = before !== this.diskState();
				this.ownerContext.emit("plugin-manager/changed", { reason });
				return result;
			}, { waitMs: this.lockWaitMs });
		}
		diskState() {
			return [
				"package.json",
				"cordis.patch.yml",
				"pnpm-workspace.yaml"
			].map((file) => {
				try {
					return readFileSync(join(this.profile.dir, file), "utf8");
				} catch (error) {
					if (error.code === "ENOENT") return "";
					throw error;
				}
			}).join("\0");
		}
	};
})();
//#endregion
export { InvalidInstallSpecError, PluginManager, PluginManager as default, classifyInstallFailure, parseInstallSpec };
