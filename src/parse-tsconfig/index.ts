import path from 'node:path';
import slash from 'slash';
import type { TsConfigJson, TsConfigJsonResolved, Cache } from '../types.js';
import { normalizeRelativePath } from '../utils/normalize-relative-path.js';
import { readJsonc } from '../utils/read-jsonc.js';
import { implicitBaseUrlSymbol, configDirPlaceholder } from '../utils/constants.js';
import { resolveExtendsPath } from './resolve-extends-path.js';

const filesProperties = ['files', 'include', 'exclude'] as const;

const resolveExtends = (
	extendsPath: string,
	fromDirectoryPath: string,
	circularExtendsTracker: Set<string>,
	cache?: Cache<string>,
) => {
	const resolvedExtendsPath = resolveExtendsPath(
		extendsPath,
		fromDirectoryPath,
		cache,
	);

	if (!resolvedExtendsPath) {
		throw new Error(`File '${extendsPath}' not found.`);
	}

	if (circularExtendsTracker.has(resolvedExtendsPath)) {
		throw new Error(`Circularity detected while resolving configuration: ${resolvedExtendsPath}`);
	}

	circularExtendsTracker.add(resolvedExtendsPath);

	const extendsDirectoryPath = path.dirname(resolvedExtendsPath);
	const extendsConfig = _parseTsconfig(resolvedExtendsPath, cache, circularExtendsTracker);
	delete extendsConfig.references;

	const { compilerOptions } = extendsConfig;
	if (compilerOptions) {
		const { baseUrl } = compilerOptions;
		if (baseUrl && !baseUrl.startsWith(configDirPlaceholder)) {
			compilerOptions.baseUrl = slash(
				path.relative(
					fromDirectoryPath,
					path.join(extendsDirectoryPath, baseUrl),
				),
			) || './';
		}

		let { outDir } = compilerOptions;
		if (outDir) {
			if (!outDir.startsWith(configDirPlaceholder)) {
				outDir = path.relative(
					fromDirectoryPath,
					path.join(extendsDirectoryPath, outDir),
				);
			}

			compilerOptions.outDir = slash(outDir) || './';
		}
	}

	for (const property of filesProperties) {
		const filesList = extendsConfig[property];
		if (filesList) {
			extendsConfig[property] = filesList.map((file) => {
				if (file.startsWith(configDirPlaceholder)) {
					return file;
				}

				return slash(
					path.relative(
						fromDirectoryPath,
						path.join(extendsDirectoryPath, file),
					),
				);
			});
		}
	}

	return extendsConfig;
};

const _parseTsconfig = (
	tsconfigPath: string,
	cache?: Cache<string>,
	circularExtendsTracker = new Set<string>(),
): TsConfigJsonResolved => {
	/**
	 * Decided not to cache the TsConfigJsonResolved object because it's
	 * mutable.
	 *
	 * Note how `resolveExtends` can call `parseTsconfig` rescursively
	 * and actually mutates the object. It can also be mutated in
	 * user-land.
	 *
	 * By only caching fs results, we can avoid serving mutated objects
	 */
	let config: TsConfigJson;
	try {
		config = readJsonc(tsconfigPath, cache) || {};
	} catch {
		throw new Error(`Cannot resolve tsconfig at path: ${tsconfigPath}`);
	}

	if (typeof config !== 'object') {
		throw new SyntaxError(`Failed to parse tsconfig at: ${tsconfigPath}`);
	}

	const directoryPath = path.dirname(tsconfigPath);

	if (config.compilerOptions) {
		const { compilerOptions } = config;
		if (
			compilerOptions.paths
			&& !compilerOptions.baseUrl
		) {
			type WithImplicitBaseUrl = TsConfigJson.CompilerOptions & {
				[implicitBaseUrlSymbol]: string;
			};
			(compilerOptions as WithImplicitBaseUrl)[implicitBaseUrlSymbol] = directoryPath;
		}
	}

	if (config.extends) {
		const extendsPathList = (
			Array.isArray(config.extends)
				? config.extends
				: [config.extends]
		);

		delete config.extends;

		for (const extendsPath of extendsPathList.reverse()) {
			const extendsConfig = resolveExtends(
				extendsPath,
				directoryPath,
				new Set(circularExtendsTracker),
				cache,
			);
			const merged = {
				...extendsConfig,
				...config,

				compilerOptions: {
					...extendsConfig.compilerOptions,
					...config.compilerOptions,
				},
			};

			if (extendsConfig.watchOptions) {
				merged.watchOptions = {
					...extendsConfig.watchOptions,
					...config.watchOptions,
				};
			}
			config = merged;
		}
	}

	if (config.compilerOptions) {
		const { compilerOptions } = config;
		const normalizedPaths = [
			'baseUrl',
			'rootDir',
		] as const;

		for (const property of normalizedPaths) {
			const unresolvedPath = compilerOptions[property];
			if (unresolvedPath && !unresolvedPath.startsWith(configDirPlaceholder)) {
				const resolvedBaseUrl = path.resolve(directoryPath, unresolvedPath);
				const relativeBaseUrl = normalizeRelativePath(path.relative(
					directoryPath,
					resolvedBaseUrl,
				));
				compilerOptions[property] = relativeBaseUrl;
			}
		}

		let { outDir } = compilerOptions;
		if (outDir) {
			if (!Array.isArray(config.exclude)) {
				config.exclude = [];
			}

			if (!config.exclude.includes(outDir)) {
				config.exclude.push(outDir);
			}

			if (!outDir.startsWith(configDirPlaceholder)) {
				outDir = normalizeRelativePath(outDir);
			}
			compilerOptions.outDir = outDir;
		}
	} else {
		config.compilerOptions = {};
	}

	if (config.include) {
		config.include = config.include.map(slash);

		if (config.files) {
			delete config.files;
		}
	} else if (config.files) {
		config.files = config.files.map(file => (
			file.startsWith(configDirPlaceholder)
				? file
				: normalizeRelativePath(file)
		));
	}

	if (config.watchOptions) {
		const { watchOptions } = config;

		if (watchOptions.excludeDirectories) {
			watchOptions.excludeDirectories = watchOptions.excludeDirectories.map(
				excludePath => slash(path.resolve(directoryPath, excludePath)),
			);
		}
	}

	return config;
};

function interpolateConfigDir<T extends string | string[]>(
	filePaths: T,
	configDir: string,
	postProcess?: (input: string) => string
): T extends string ? string : string[];
// eslint-disable-next-line pvtnbr/prefer-arrow-functions
function interpolateConfigDir(
	filePaths: string | string[],
	configDir: string,
	postProcess: (input: string) => string = value => value,
): string | string[] {
	if (Array.isArray(filePaths)) {
		return filePaths.map(filePath => interpolateConfigDir(filePath, configDir, postProcess));
	}

	if (filePaths.startsWith(configDirPlaceholder)) {
		return postProcess(slash(path.join(configDir, filePaths.slice(configDirPlaceholder.length))));
	}

	return filePaths;
}

export const parseTsconfig = (
	tsconfigPath: string,
	cache: Cache<string> = new Map(),
): TsConfigJsonResolved => {
	const resolvedTsconfigPath = path.resolve(tsconfigPath);
	const config = _parseTsconfig(resolvedTsconfigPath, cache);

	/**
	 * @see https://github.com/microsoft/TypeScript/issues/57485#issuecomment-2027787456
	 * exclude paths, as it requires custom processing
	 */
	const compilerFieldsWithConfigDir = [
		'outDir',
		'declarationDir',
		'outFile',
		'rootDir',
		'baseUrl',
		'tsBuildInfoFile',
		'rootDirs',
		'typeRoots',
	] as const satisfies Array<keyof NonNullable<TsConfigJson['compilerOptions']>>;

	const configDir = path.dirname(resolvedTsconfigPath);
	if (config.compilerOptions) {
		for (const field of compilerFieldsWithConfigDir) {
			const value = config.compilerOptions[field];

			if (value) {
				/**
				 * I used Object.assign instead of the direct assignment to work around TS bug
				 * (it fails to infer types correctly).
				 * @see https://github.com/microsoft/TypeScript/issues/33912
 				 */
				Object.assign(config.compilerOptions, {
					[field]: interpolateConfigDir(
						value,
						configDir,
						interpolated => normalizeRelativePath(path.relative(configDir, interpolated)),
					),
				});
			}
		}

		const { paths } = config.compilerOptions;
		if (paths) {
			for (const name of Object.keys(paths)) {
				paths[name] = paths[name].map(
					filePath => interpolateConfigDir(filePath, configDir) ?? filePath,
				);
			}
		}
	}

	for (const property of filesProperties) {
		if (config[property]) {
			config[property] = config[property].map(
				filePath => interpolateConfigDir(filePath, configDir) ?? filePath,
			);
		}
	}

	return config;
};
