import { load } from "cheerio";
import * as gm from "gm";
import * as bb from "bluebird";
import * as _ from "lodash";
import { compile } from "dot";
import { join, extname } from "path";
import { readFileSync } from "fs";
import { lookup } from "mime-types";
import { tmpFile, readFileAsync, debug } from "./util";
import * as CleanCSS from "clean-css";
import { minify as minifyJS } from "uglify-js";
import { minify as _minifyHTML } from "html-minifier";

/**
 * @hidden
 */
function minifyHTML(html: string) {
    return _minifyHTML(html, {
        removeComments: true,
        removeRedundantAttributes: true,
        collapseWhitespace: true
    });
}

/**
 * @hidden
 */
function templateLoader(filename: string) {
    return readFileSync(join(__dirname, "template/", filename), "utf-8");
}

const [
    /**
     * @hidden
     */
    template,
    /**
     * @hidden
     */
    cssTemplate
] = ["entry.html", "default.css"].map(templateLoader);
const [
    /**
     * Offline service worker template
     * @hidden
     */
    offlineJSTemplate,
    /**
     * Offline page template
     * @hidden
     */
    offlineHTMLTemplate
] = ["offline.js", "offline.html"].map(file => compile(templateLoader(file)));

export interface EntryOption {
    /**
     * Title of app
     *
     * It will be used in generating manifest, meta, title tag
     * @ref https://developer.mozilla.org/ko/docs/Web/Manifest#name
     */
    title: string;
    /**
     * File name of entry html
     *
     * @default index.html
     */
    entryName?: string;
    /**
     * Enable fullscreen feature by enable app-capable
     *
     * @ref https://developer.mozilla.org/ko/docs/Web/Manifest#display
     * @default true
     */
    fullscreen?: boolean;
    /**
     * Desired orientation
     *
     * It influence to viewport, orientation field in manifest.
     * portrait will set viewport by height, landscape will set viewport by width
     * @ref https://developer.mozilla.org/ko/docs/Web/Manifest#orientation
     * @default portrait
     */
    orientation?: "portrait" | "landscape";
    /**
     * Viewport size
     *
     * px or device size
     * @ref https://developer.mozilla.org/en-US/docs/Mozilla/Mobile/Viewport_meta_tag
     * @default device
     */
    viewport?: number | "device";
    /**
     * Scalability
     * @ref https://developer.mozilla.org/en-US/docs/Mozilla/Mobile/Viewport_meta_tag
     */
    scale?: {
        /**
         * Initial scale
         *
         * @default 1
         */
        initial?: number;
        /**
         * User scalable
         *
         * @default false
         */
        scalable?: boolean;
        /**
         * Minimum scale
         *
         * @default not set
         */
        minimum?: number;
        /**
         * Maximum scale
         *
         * @default not set
         */
        maximum?: number;
    };
    /**
     * Background color
     *
     * @default not set - commonly it will showed as white
     */
    backgroundColor?: string;
    /**
     * Webapp theme color
     *
     * @ref https://developer.mozilla.org/ko/docs/Web/Manifest#theme_color
     * @default not set
     */
    themeColor?: string; // default not set
    /**
     * App icon
     *
     * @ref https://developer.mozilla.org/ko/docs/Web/Manifest#icons
     * @default not set
     */
    icon?: string;
    /**
     * Show offline page via service worker
     *
     * @default not include
     */
    offline?: {
        /**
         * Message when app is offline
         */
        message: string;
        /**
         * Image show when app is offline
         *
         * @default not set
         */
        image?: string;
    };
    /**
     * @hidden
     */
    _path: string;
}

/**
 * @hidden
 */
export function generateEntry(prefix: string, entryJS: string, option: EntryOption) {
    debug("Generate Entry html");
    const ret: {[key: string]: string | Buffer} = {};
    const android_manifest: any = {};
    const $ = load(template);

    if (option.entryName === undefined) {
        option.entryName = "index.html";
    }
    android_manifest.start_url = option.entryName;

    $("title").text(option.title);
    $("head").append(`<meta name="apple-mobile-web-app-title" content="${option.title}" />`);
    android_manifest.name = option.title;

    if (option.fullscreen !== false) {
        option.fullscreen = true;
    }
    if (option.fullscreen) {
        $("head").append("<meta name=\"apple-mobile-web-app-capable\" content=\"yes\">");
        $("head").append("<meta name=\"mobile-web-app-capable\" content=\"yes\" />");
        android_manifest.display = "standalone";
    }

    if (option.orientation === undefined) {
        option.orientation = "portrait";
    }
    if (option.viewport === undefined) {
        option.viewport = "device";
    }
    if (option.scale === undefined) {
        option.scale = {
            initial: 1.0,
            scalable: false
        };
    }
    android_manifest.orientation = option.orientation;
    const scalableStr = option.scale.scalable ? "yes" : "no";
    let viewportString = `initial-scale=${option.scale.initial},user-scalable=${scalableStr}`;
    const orientationTarget = option.orientation === "portrait" ? "height" : "width";
    viewportString += `,${orientationTarget}=${option.viewport}`;
    if (option.viewport === "device") {
        viewportString += `-${orientationTarget}`;
    }
    if (option.scale.maximum) {
        viewportString += `,maximum-scale=${option.scale.maximum}`;
    }
    if (option.scale.minimum) {
        viewportString += `,minimum-scale=${option.scale.minimum}`;
    }
    const viewport = $("head").append(`<meta name="viewport" content="${viewportString}" />`);
    let css = cssTemplate;
    if (option.backgroundColor) {
        css += `body { background-color: ${option.backgroundColor} }`;
        android_manifest.background_color = option.backgroundColor;
    }
    $("head").append("<style type=\"text/css\"></style>");
    $("head style").text(new CleanCSS({}).minify(css).styles);

    if (option.themeColor) {
        android_manifest.theme_color = option.themeColor;
        $("head").append(`<meta name="theme-color" content="${option.themeColor}" />`);
    }

    $("head").append("<link rel=\"manifest\" href=\"android_manifest.json\" >");

    return new bb<void>(resolve => {
        if (option.icon) {
            debug("Generate icon");
            const icon = gm(option.icon);
            const android: {[key: string]: number} = {
                "36": 0.75,
                "48": 1.0,
                "72": 1.5,
                "96": 2.0,
                "144": 3.0,
                "192": 4.0
            };
            const ios: {[key: string]: string} = {
                "180": "phone@3",
                "120": "phone@2",
                "167": "padpro",
                "152": "pad"
            };
            const res = _.sortedUniq(_.sortBy(_.concat(_.keys(android), _.keys(ios))));
            icon.identify((error, info) => {
                const possible = _.filter(res, r => parseInt(r) <= info.size.width);
                return bb.map(possible, size => new bb<[string, Buffer]>((resolve, reject) => {
                    const tmp = tmpFile({
                        discardDescriptor: true
                    });
                    const s = parseInt(size);
                    gm(option.icon).resize(s, s)
                        .write(tmp.name, err => {
                            if (err) {
                                reject(err);
                            }
                            readFileAsync(tmp.name).then(buf => {
                                tmp.removeCallback();
                                resolve([size, buf]);
                            });
                        });
                })).then(converteds => {
                    android_manifest.icons = [];
                    for (const converted of converteds) {
                        const [size, buffer] = converted;
                        let name: string;
                        if (ios[size] !== undefined) {
                            name = `launch-icon-${ios[size]}.png`;
                            $("head").append(`<link rel="apple-touch-icon" sizes="${size}x${size}" href="${prefix}${name}" />`);
                        }
                        else {
                            name = `launch-icon-${android[size]}.png`;
                            android_manifest.icons.push({
                                "src": prefix + name,
                                "sizes": `${size}x${size}`,
                                "type": "image/png",
                                "density": android[size]
                            });
                            $("head").append(`<link rel="icon" sizes="${size}x${size}" href="${prefix}${name}" />`);
                        }
                        ret[name] = buffer;
                    }
                }).then(resolve);
            });
        }
        else {
            resolve();
        }
    }).then(() => {
        $("body").append(`<span id="wait_script"><h1>${option.title}</h1><br /><span>LOADING...</span></span>`);
        $("body").append(`<script src="${prefix}${entryJS}" onload="var node = document.getElementById('wait_script'); if (node.remove) { node.remove(); } else { node.removeNode(true); }"></script>`);

        if (option.offline !== undefined) {
            $("body").append(`<script>if ('serviceWorker' in navigator) { navigator.serviceWorker.register("${prefix}offline.js").catch(() => {}); }</script>`);
            const params: {[key: string]: string} = {
                title: option.title,
                prefix,
                message: option.offline.message
            };
            if (option.offline.image !== undefined) {
                const imageMime = lookup(extname(option.offline.image));
                const imageBase64 = readFileSync(option.offline.image).toString("base64");
                params["image"] = `data:${imageMime};base64,${imageBase64}`;
            }
            ret["offline.js"] = minifyJS(offlineJSTemplate(params), {
                mangle: {
                    toplevel: true
                }
            }).code;
            ret["offline.html"] = minifyHTML(offlineHTMLTemplate(params));
        }

        ret[option.entryName] = minifyHTML($.html());
        ret["android_manifest.json"] = JSON.stringify(android_manifest);

        return ret;
    });
}