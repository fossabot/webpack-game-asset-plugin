import * as wp from "webpack";
import * as bb from "bluebird";
import * as _ from "lodash";
import * as audiosprite from "audiosprite";
import { InternalOption, FilesByType, File, Assets } from "./option";
import { tmpDir, localJoinPath, readFileAsync } from "./util";
import { relative } from "path";

/**
 * @hidden
 */
export function processAudio(context: string, option: InternalOption, compilation: wp.Compilation, files: [FilesByType, Assets]): bb<[FilesByType, Assets]> {
    if (!option.audioSprite) {
        return bb.resolve(files);
    }

    const [toCopy, assets] = files;
    const audios = toCopy["audio"];
    toCopy["audio"] = {};
    assets["audio"] = {};
    assets["audioSprite"] = {};
    return new bb<[FilesByType, Assets]>((resolve, reject) => {
        const tmp = tmpDir();
        audiosprite(_.map(audios, audio => audio.srcFile), {
            output: localJoinPath(tmp.name, "as")
        }, (error, obj) => {
            if (error) {
                reject(error);
            }

            const resourceNames = obj.resources.map(v => relative(tmp.name, v));
            bb.map(obj.resources, (res, i) => readFileAsync(res).then(audio => {
                compilation.assets[resourceNames[i]] = {
                    size: () => audio.length,
                    source: () => audio
                };
            }));
            obj.resources = resourceNames;
            const audioSpriteAtlas = JSON.stringify(obj);
            compilation.assets["as.json"] = {
                size: () => audioSpriteAtlas.length,
                source: () => audioSpriteAtlas
            };
            assets["audioSprite"]["as"] = {
                args: [obj.resources, "as.json"]
            };

            resolve([toCopy, assets]);
        });
    });
}