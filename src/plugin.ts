import "es6-shim";
import * as wp from "webpack";
import * as nsg from "node-sprite-generator";
import * as _glob from "glob";
import * as bb from "bluebird";
import * as _ from "lodash";
import { lookup, types } from "mime-types";
import { v4 as uuidV4 } from "uuid";
import { isAbsolute, extname, dirname, relative as localRelativePath, parse, join } from "path";
import { formatPath, joinPath, normalizePath, readFileAsync, relativePath, statAsync, debug, parsePath, localJoinPath, collectDependentAssets, getFileHash, isExists, getLocalizedPath } from "./util";
import { InternalOption, GameAssetPluginOption, publicOptionToprivate, File, FilesByType, Assets, isCustomAsset, ProcessContext, Compilation } from "./option";
import { generateEntry } from "./entryGenerator";
import * as jsonpath from "jsonpath";

if (Promise !== bb as any) {
    Promise = bb as any;
}

// for shader
types["frag"] = "application/shader";
types["fnt"] = "font";

/**
 * @hidden
 */
const glob = bb.promisify<string[], string, _glob.IOptions>(_glob);

/**
 * @hidden
 */
interface ParticleJson {
    children?: ParticleJson[];
    image?: string;
}

/**
 * @hidden
 */
function isOldModule(module: wp.Module): module is wp.OldModule {
    return (module as wp.OldModule).loaders !== undefined;
}

export default class GameAssetPlugin implements wp.Plugin, ProcessContext {
    public option: InternalOption;
    /**
     * @hidden
     */
    public context: string;
    private entryName: string;
    private fileDependencies: string[] = [];
    private newFileDependencies: string[] = [];
    private contextDependencies: string[] = [];
    private newContextDependencies: string[] = [];
    private startTime: number;
    private prevTimestamps: {[key: string]: number} = {};
    private configFiles: string[] = [];
    /**
     * @hidden
     */
    public compilation: Compilation = null;
    /**
     * @hidden
     */
    public cache: { [key: string]: any } = {};
    public static loaderPath = localJoinPath(__dirname, "assetLoader.js");

    constructor(option: GameAssetPluginOption) {
        if (option.entryOption) {
            this.configFiles.push(option.entryOption);
        }
        if (typeof option.atlasMap === "string") {
            this.configFiles.push(option.atlasMap);
        }
        this.option = publicOptionToprivate(option);
        this.startTime = Date.now();
    }

    public toAbsPath(path: string) {
        if (isAbsolute(path)) {
            return path;
        }

        return localJoinPath(this.context, path);
    }

    private assetCache: { [key: string]: File } = {};
    private refAssetCache: { [key: string]: File[] } = {};

    private async emit(compiler: wp.Compiler, compilation: Compilation, callback: (err?: Error) => void): Promise<void> {
        try {
            let files: File[];
            if (!this.option.collectAll) {
                files = await this.collectAssetFromModule();
            }
            else {
                files = await this.collectFiles();
            }
            await this.collectLocalized(files);
            const assetsByModule = await this.identifyAssetReferencedModules();
            const fileByType = await this.classifyFiles(files);
            const assets = await this.processAssets(fileByType);
            await this.generateListForModule(assetsByModule);
            if (this.option.emitAllAssetsList) {
                await this.generateList(assets);
            }
            await this.generateEntry();
            callback();
        }
        catch (e) {
            debug("Error occured while emitting");
            callback(e);
        }
    }

    private afterEmit(compilation: wp.Compilation, callback: (err?: Error) => void) {
        debug(`added ${this.newFileDependencies.length} file dependencies`);
        this.newFileDependencies.push(...this.configFiles);
        this.newFileDependencies = this.newFileDependencies.map(p => this.toAbsPath(p));
        debug(this.newFileDependencies[0]);
        compilation.fileDependencies.push(...this.newFileDependencies);
        this.fileDependencies = this.newFileDependencies;
        debug(compilation.fileDependencies.length);
        debug(`added ${this.newContextDependencies.length} context dependencies`);
        this.newContextDependencies = this.newContextDependencies.map(p => this.toAbsPath(p));
        compilation.contextDependencies.push(...this.newContextDependencies);
        this.contextDependencies = this.newContextDependencies;
        this.newContextDependencies = [];
        this.newFileDependencies = [];

        _.assign(this.prevTimestamps, compilation.fileTimestamps);
        callback();
    }

    private beginCompilation(compilation: Compilation) {
        this.compilation = compilation;
        compilation.__game_asset_plugin_option__ = this.option;
    }

    apply(compiler: wp.Compiler) {
        this.context = compiler.options.context;
        this.newFileDependencies = _.map(this.newFileDependencies, path => this.toAbsPath(path));
        this.entryName = compiler.options.output.filename;
        compiler.plugin("compilation", this.beginCompilation.bind(this));
        compiler.plugin("emit", this.emit.bind(this, compiler));
        compiler.plugin("after-emit", this.afterEmit.bind(this));
        compiler.plugin("normal-module-factory", nmf => {
            nmf.plugin("before-resolve", (result: any, callback: any) => {
                if (result.request === "webpack-game-asset-plugin/helper") {
                    result.request = `game-asset?info=${result.contextInfo.issuer}!${result.request}`;
                }
                return callback(null, result);
            });
        });
    }

    private async processAssets(fileByType: FilesByType): Promise<Assets> {
        debug("begin process assets");
        let files: [FilesByType, Assets] = [fileByType, Object.assign({}, fileByType)];
        if (this.option.makeAtlas) {
            const { processImages } = await import("./processImages");
            files = await processImages(
                this, this.option, files
            );
        }
        if (this.option.mergeJson) {
            const { processJson } = await import("./processJson");
            files = await processJson(this, files);
        }
        if (files[0]["font"]) {
            const { processFonts } = await import("./processFont");
            files = await processFonts(this, files);
        }
        if (this.option.audioSprite || this.option.audioEncode) {
            const { processAudio } = await import("./processAudio");
            files = await processAudio(this, files);
        }
        const copies = _.flatten(
            _.map(
                files[0],
                byType => _.values(byType)
            )
        );

        let copied = 0;
        for (const copy of copies) {
            if (!this.isChanged(copy.srcFile)) {
                continue;
            }
            copied++;
            if (typeof copy.outFile !== "string") {
                // something really wrong
                continue;
            }

            if (copy.data != null) {
                // generated just copy it
                this.compilation.assets[copy.outFile] = {
                    size() { return copy.data.length; },
                    source() { return copy.data; }
                };
            } else {
                for (const lng of copy.localized) {
                    const content = await readFileAsync(getLocalizedPath(copy.srcFile, lng));
                    this.compilation.assets[getLocalizedPath(copy.outFile, lng)] = {
                        size() { return content.length; },
                        source() { return content; },
                    };
                }
            }
        }
        debug(`${copied} items are copied`);

        return files[1];
    }

    private generateList(fileByType: Assets) {
        debug("begin generate list");
        const listData = JSON.stringify(
            _.fromPairs(
                _.map(
                    fileByType,
                    (a, ak) => [
                        ak,
                        _.fromPairs(_.map(a, (v, k) => [k, isCustomAsset(v) ? v.args : v.outFile]))
                    ]
                )
            )
        );
        this.compilation.assets[this.option.listOut] = {
            size: () => listData.length,
            source: () => listData,
        };
        return bb.resolve();
    }

    private referencedModules: { [key: string]: wp.Module} = {};
    private cachedAssets: { [key: string]: File[] } = {};
    private async generateListForModule(assetsForModule: { [key: string]: string[] }) {
        const compilation = this.compilation;
        _.forEach(this.referencedModules, (module: wp.Module, hash: string) => {
            assetsForModule[module.resource] = [];
            const assets: string[] = collectDependentAssets(this, module, assetsForModule, GameAssetPlugin.loaderPath);
            const assetsInfo: File[] = _.sortBy(_.filter(_.uniq(_.concat(
                this.refAssetCache[module.resource],
                assets.map(asset => this.assetCache[asset]),
                _.flatten(assets.map(asset => _.defaultTo(this.refAssetCache[asset], [])))))), f => f.srcFile);
            const assetsJson: { [key: string]: { [key: string]: string[] } } = {};
            let isChanged = !_.isEqual(this.cachedAssets[module.resource] || [], assetsInfo);
            for (const asset of assetsInfo) {
                if (!isChanged && this.isChanged(asset.srcFile)) {
                    isChanged = true;
                }
                if (assetsJson[asset.outType] === undefined) {
                    assetsJson[asset.outType] = {};
                }
                assetsJson[asset.outType][_.defaultTo(asset.outName, asset.name)] = typeof asset.outFile === "string" ? [asset.outFile] : asset.outFile;
            }

            this.cachedAssets[module.resource] = assetsInfo;
            const contentStr = JSON.stringify(assetsJson);
            compilation.assets[hash + ".json"] = {
                size() {
                    return contentStr.length;
                },
                source() {
                    return contentStr;
                }
            };
        });
    }

    private async identifyAssetReferencedModules() {
        const assetsForModule: { [key: string]: string[] } = {};
        const modules = _.flatten(_.map(this.compilation.chunks, chunk => chunk.getModules()));
        this.referencedModules = Object.assign(this.referencedModules, this.compilation._referenced_modules_);
        const removedModuleHash: string[] = [];
        const that = this;
        _.forEach(this.referencedModules, (module: wp.Module, hash: string) => {
            if (!_.includes(modules, module)) {
                removedModuleHash.push(hash);
                return;
            }
            assetsForModule[module.resource] = [];
            const assets: string[] = collectDependentAssets(this, module, assetsForModule, GameAssetPlugin.loaderPath);
            const assetsInfo = _.filter(_.uniq(_.concat(
                this.refAssetCache[module.resource],
                assets.map(asset => this.assetCache[asset]),
                _.flatten(assets.map(asset => _.defaultTo(this.refAssetCache[asset], []))))));
            for (const asset of assetsInfo) {
                if (asset.referencedModules === undefined) {
                    asset.referencedModules = [];
                }
                if (asset.referencedModules.indexOf(module.resource) === -1) {
                    asset.referencedModules.push(module.resource);
                }
            }
        });

        for (const hash of removedModuleHash) {
            delete this.referencedModules[hash];
        }

        this.compilation._referenced_modules_ = {};

        return assetsForModule;
    }

    private a = true;
    private async collectAssetFromModule() {
        const compilation = this.compilation;
        const assets = _.clone(compilation._game_asset_) || {};
        for (const chunk of compilation.chunks) {
            chunk.forEachModule(module => {
                if (!module.userRequest) {
                    return;
                }
                if (!isOldModule(module)) {
                    return;
                }
                if (_.find(module.loaders, (loader: any) => loader.loader === GameAssetPlugin.loaderPath) == null) {
                    return;
                }
                if (!this.assetCache[module.resource]) {
                    return;
                }

                assets[module.resource] = this.assetCache[module.resource];
            });
        }
        const files = await this.extendFiles(assets);
        for (const file of files) {
            this.assetCache[this.toAbsPath(file.srcFile)] = file;
        }

        return files;
    }

    private async collectFiles(): Promise<File[]> {
        debug("collect assets");
        const filesByRoot = await bb.map(this.option.assetRoots, async (root) => {
            const { src: srcRoot, out: outRoot } = root;
            const items = await glob(srcRoot + "/**/*", {
                ignore: this.option.excludes
            });

            return {
                srcRoot,
                outRoot,
                items
            };
        });
        return bb.all(_.flatten(
            _.map(filesByRoot,
                async val => val.items.map<Promise<File>>(
                    async file => {
                        file = normalizePath(file);
                        const relPath = relativePath(val.srcRoot, file);
                        const path = parsePath(relPath);
                        return {
                            name: joinPath(path.dir, path.name),
                            ext: path.ext,
                            outFile: joinPath(val.outRoot, relPath),
                            srcFile: file,
                            hash: (await getFileHash("md5", file)).digest("hex"),
                            localized: [""]
                        };
                    }
                )
            )
        ));
    }

    private async collectLocalized(files: File[]) {
        return bb.map(files, file => {
            const parsedPath = parse(file.srcFile);
            return bb.map(this.option.i18nLanguages, async lng => {
                const localizedPath = getLocalizedPath(parsedPath, lng);
                if (await isExists(localizedPath)) {
                    file.localized.push(lng);
                }
            });
        }).thenReturn(files);
    }

    private filterChanged(files: File[]) {
        const changedOrAdded = _.keys(this.compilation.fileTimestamps).filter(file => {
            if (!_.includes(this.fileDependencies, file)) {
                return false;
            }

            return this.isChanged(file);
        });
    }

    public isChanged(file: string) {
        file = this.toAbsPath(file);
        const prevTimestamp = this.prevTimestamps[file] || this.startTime;
        const curTimeStamp = this.compilation.fileTimestamps[file] || Infinity;
        return prevTimestamp < curTimeStamp;
    }

    private async extendFiles(allFiles: {[key: string]: File}): Promise<File[]> {
        const files = _.toPairs(allFiles) as [string, File][];
        for (const kv of files)
        {
            const [key, file] = kv;
            if (!this.isChanged(file.srcFile)) {
                if (this.refAssetCache[key]) {
                    for (const refFile of this.refAssetCache[key]) {
                        allFiles[refFile.name] = refFile;
                    }
                }
                continue;
            }

            const fileDir = dirname(file.srcFile);
            if (file.ext === ".json") {
                let ref: string = null;
                if (file.query["pre"]) {
                    ref = this.option.refPresets[file.query["pre"]];
                }
                if (file.query["ref"]) {
                    ref = file.query["ref"];
                }
                this.refAssetCache[key] = [];
                if (file.query["async"]) {
                    this.refAssetCache[key].push(file);
                }

                if (ref !== null) {
                    const buf = await readFileAsync(file.srcFile);
                    const data = JSON.parse(buf.toString("utf-8"));
                    try {
                        const paths = jsonpath.paths(data, ref);
                        for (const path of paths) {
                            let ptr = data;
                            let parent = null;
                            for (const component of path) {
                                if (component === "$") {
                                    ptr = data;
                                    parent = null;
                                }
                                else {
                                    parent = ptr;
                                    ptr = ptr[component];
                                }
                            }

                            const lastComponent = _.last(path);
                            const srcFile = localJoinPath(fileDir, ptr);
                            const outFile = localRelativePath(this.context, srcFile).replace(/\\/g, "/");
                            const ext = extname(outFile);
                            const name = _.clone(outFile);
                            parent[lastComponent] = name;
                            const hash = await getFileHash("md5", srcFile);
                            if (allFiles[srcFile] === undefined) {
                                allFiles[srcFile] = {
                                    name,
                                    ext,
                                    hash: hash.digest("hex"),
                                    srcFile,
                                    outFile,
                                    query: {},
                                    localized: [""]
                                };
                            }

                            this.refAssetCache[key].push(allFiles[srcFile]);
                        }
                    }
                    catch (e) {
                        throw new Error(`Error occured while precessing ${key} ${(e as Error).stack}`);
                    }

                    file.data = JSON.stringify(data);
                }
            }
        }

        return _.values(allFiles);
    }

    private async classifyFiles(files: File[]): Promise<FilesByType> {
        debug("classify collected files by mime-type");
        const cat_files = await bb.map(
            files,
            file => statAsync(file.srcFile)
                .then<File & { cat: string }>(fileStat => {
                    if (fileStat == null) {
                        return;
                    }
                    if (fileStat.isDirectory()) {
                        return Object.assign(file, {
                            cat: "dir"
                        });
                    }

                    const mime = lookup(file.ext);
                    if (mime === false) {
                        return;
                    }

                    let cat = mime.split("/")[0];
                    if (cat === "application") {
                        cat = mime.split("/")[1];
                    }
                    file.type = cat;
                    if (file.outType === undefined) {
                        file.outType = cat;
                    }

                    return Object.assign(file, {
                        cat
                    });
                })
        );
        const groups = _.groupBy(_.filter(cat_files), file => file.cat);
        if (groups["dir"]) {
            for (const file of groups["dir"]) {
                if (!_.includes(this.contextDependencies, file.srcFile)) {
                    this.newContextDependencies.push(file.srcFile);
                }
            }
            delete groups["dir"];
        }
        const fileByType: FilesByType = {};
        for (const cat of _.keys(groups)) {
            for (const file of groups[cat]) {
                if (!_.includes(this.newFileDependencies, file.srcFile)) {
                    this.newFileDependencies.push(file.srcFile);
                }

                if (fileByType[cat] === undefined) {
                    fileByType[cat] = {};
                }

                fileByType[cat][file.name] = file;
            }
        }

        return fileByType;
    }

    private async generateEntry(): Promise<void> {
        const compilation = this.compilation;
        const entrypoints = _.flatten<string>(_.map(compilation.entrypoints, (entrypoint: wp.EntryPoint, name) => _.map(entrypoint.chunks, (chunk: wp.Chunk) => {
            const filenameTemplate = chunk.filenameTemplate ? chunk.filenameTemplate :
                chunk.isInitial() ? compilation.outputOptions.filename :
                compilation.outputOptions.chunkFilename;
            const useChunkHash = !chunk.hasRuntime() || (compilation.mainTemplate.useChunkHash && compilation.mainTemplate.useChunkHash(chunk));
            const path = compilation.getPath(filenameTemplate, {
                noChunkHash: !useChunkHash,
                chunk
            });
            return path;
        })));

        let publicPath: string = compilation.outputOptions.publicPath;
        const useHash = publicPath.indexOf("[hash]");
        if (publicPath != null) {
            if (_.last(publicPath) !== "/") {
                publicPath += "/";
            }
        }
        else {
            publicPath = "";
        }
        publicPath = publicPath.replace("[hash]", compilation.hash);
        const option = await this.option.entryOption(this.context);
        const deps = [option._path];

        if (option.icon) {
            this.newFileDependencies.push(option.icon);
            deps.push(option.icon);
        }

        if (option.offline && option.offline.image) {
            this.newFileDependencies.push(option.offline.image);
            deps.push(option.offline.image);
        }

        if (!useHash && !_.some(deps, d => this.isChanged(d))) {
            return;
        }

        const files = await generateEntry(publicPath, entrypoints, compilation.hash, option);

        _.forEach(files, (content, name) => {
            compilation.assets[name] = {
                size: () => content.length,
                source: () => content
            };
        });
    }
}
