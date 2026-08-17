"use strict";

// Stats to show in order
const STAT_ROWS = [
    ["articles", "Content pages"],
    ["pages", "Total pages"],
    ["images", "Files"],
    ["edits", "Edits"],
    ["activeusers", "Active users"],
    ["admins", "Admins"],
];

// Wiki farms, matched by host suffix.
// role: origin or destination
// fold: true if lang paths join base URL (example.fandom.com/es)
// api: false means no MediaWiki API
const FARMS = [
    { suffix: "wiki.gg", label: "wiki.gg", role: "destination", fold: true },
    { suffix: "miraheze.org", label: "Miraheze", role: "destination" },
    { suffix: "shoutwiki.com", label: "ShoutWiki", role: "destination" },
    { suffix: "telepedia.net", label: "Telepedia", role: "destination" },
    { suffix: "paradoxwikis.com", label: "Paradox", role: "destination" },
    { suffix: "hoodedhorse.com", label: "Hooded Horse", role: "destination", fold: true },
    { suffix: "fandom.com", label: "Fandom", role: "origin", fold: true },
    { suffix: "neoseeker.com", label: "Neoseeker", role: "origin" },
    { suffix: "fextralife.com", label: "Fextralife", role: "origin", api: false },
];

const ORIGIN_FARM_NAMES = FARMS.filter((farm) => farm.role === "origin").map((farm) => farm.label);

// Redirect data, one file per language (v1/en-data.json)
const DATA_API = "https://api.getindie.wiki/v1";

const TOOL_URL = "https://getindie.wiki/analysis/";

// Fetch favicons via images.weserv.nl (bypass CORS restrictions)
const ICON_PROXY = "https://images.weserv.nl/?w=16&h=16&fit=inside&output=png&url=";

// Script path that is a language code
const SCRIPT_PATH_LANG_RE = /^[a-z]{2,3}(?:-[a-z0-9]+)*$/;
// URL segment that looks like a language
const URL_SEGMENT_LANG_RE = /^[a-z]{2}(?:-[a-z0-9]+)*$/;
// Base language code
const BASE_LANG_RE = /^[a-z][a-z0-9]{1,7}$/;

const OFFICIAL_RE = /\bofficial\b/i;

const FETCH_TIMEOUT = 10000;

function farmFor(host) {
    return FARMS.find((farm) => host === farm.suffix || host.endsWith("." + farm.suffix));
}

// Host part of a base URL
// Drops any folded script path
function baseHost(baseUrl) {
    return (baseUrl || "").split("/")[0];
}

function slug(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// The file to edit in the data repo
function sitesFile(language) {
    return `data/sites${language.toUpperCase()}.json`;
}

function toBaseLanguage(value) {
    value = (value || "").split("-")[0].toLowerCase();
    return BASE_LANG_RE.test(value) ? value : null;
}

function cleanText(value, limit = 200) {
    if (!value) return "";
    return value.replace(/\s+/g, " ").trim().replaceAll("`", "'").replaceAll("|", "-").slice(0, limit);
}

// Keep remote text from acting as markdown, mentions, or HTML
function mdEscape(value) {
    return value.replace(/([\\[\]@<>])/g, "\\$1");
}

// Warnings are written as markdown
// plain() strips the backticks for the page
function codeSpan(value) {
    return "`" + cleanText(value) + "`";
}

function plain(value) {
    return value.replaceAll("`", "");
}

function normalizeInputUrl(raw) {
    if (!raw) return null;
    let url = raw.trim().replace(/^<|>$/g, "");
    if (!url.includes("://")) url = "https://" + url;
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    const labels = parsed.hostname.split(".");
    if (labels.length < 2 || labels[labels.length - 1].length < 2) return null;
    parsed.protocol = "https:";
    return parsed.href;
}

async function fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`status ${response.status}`);
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

function generalStr(general, key, fallback = "") {
    const value = general[key];
    return typeof value === "string" ? value : fallback;
}

// Probe api.php under every path prefix at once
// Longest first, then /w
// The winner is the earliest reply whose scriptpath matches its prefix
async function fetchSiteinfo(parsed) {
    const base = `${parsed.protocol}//${parsed.host}`;
    const segments = parsed.pathname.split("/").filter(Boolean);
    const prefixes = [];
    for (let i = segments.length; i >= 0; i--) {
        prefixes.push(
            segments
                .slice(0, i)
                .map((s) => "/" + s)
                .join("")
        );
    }
    if (!prefixes.includes("/w")) prefixes.push("/w");

    const probes = prefixes.map((prefix) =>
        fetchJson(
            `${base}${prefix}/api.php?action=query&meta=siteinfo&siprop=general%7Cstatistics&format=json&origin=*`
        ).catch(() => null)
    );

    let fallback = null;
    for (const [index, probe] of probes.entries()) {
        const result = await probe;
        if (!result?.query?.general || typeof result.query.general !== "object") continue;
        const scriptpath = generalStr(result.query.general, "scriptpath").replace(/\/+$/, "").toLowerCase();
        if (scriptpath === prefixes[index].toLowerCase()) return result;
        // Wrong-prefix answer, better than nothing
        fallback ??= result;
    }
    return fallback;
}

// No API, so read it off the URL
// Bare host, "/" as content path, and a spaced title
function profileWithoutApi(parsed, farm) {
    const segment = parsed.pathname.split("/").filter(Boolean)[0] || "";
    let title = "";
    try {
        title = cleanText(decodeURIComponent(segment.replaceAll("+", " ")));
    } catch {}

    const warnings = [
        `${farm.label} wikis have no public API, so stats are unavailable and the ` +
            `name and main page come from the pasted URL; check them by hand.`,
    ];
    if (!title) {
        warnings.push(
            `The pasted ${farm.label} URL has no page path; paste the wiki's main ` +
                `page URL to fill in the name and main page.`
        );
    }

    return {
        url: parsed.href,
        warnings,
        stats: {},
        name: title,
        language: "en",
        fullLanguage: "en",
        baseUrl: cleanText(parsed.hostname),
        contentPath: "/",
        mainPage: title || null,
        official: OFFICIAL_RE.test(title),
        farm,
    };
}

// Wiki siteinfo -> profile
// Wikis with no API skip searchPath, platform, generator, and iconUrl
async function profileWiki(url) {
    const parsed = new URL(url);
    const inputFarm = farmFor(parsed.hostname);
    if (inputFarm?.api === false) return profileWithoutApi(parsed, inputFarm);

    const profile = { url, warnings: [], stats: {} };
    const data = await fetchSiteinfo(parsed);
    if (!data) {
        profile.warnings.push(
            `Could not reach a MediaWiki API for ${codeSpan(url)}. The wiki may run ` +
                `other software, block cross-site requests, or be offline. Details and ` +
                `stats need manual review.`
        );
        return profile;
    }

    const general = data.query.general;

    let serverBase = url;
    try {
        serverBase = new URL(generalStr(general, "server"), url).href;
    } catch {}
    const host = new URL(serverBase).hostname;

    let fullLanguage = generalStr(general, "lang");
    let baseLanguage = toBaseLanguage(fullLanguage);
    if (baseLanguage === null && fullLanguage) {
        profile.warnings.push("The wiki reported an unusable language code; the language needs manual review.");
    }

    const scriptPath = generalStr(general, "scriptpath");
    const variant = scriptPath.replace(/^\/|\/$/g, "").toLowerCase();

    const firstSegment = (parsed.pathname.split("/").filter(Boolean)[0] || "").toLowerCase();
    if (URL_SEGMENT_LANG_RE.test(firstSegment) && variant !== firstSegment && !variant.startsWith(firstSegment + "/")) {
        profile.warnings.push(
            `${codeSpan(url)} has a language path the wiki does not report as a ` +
                `script path; it may be a translated section of one wiki. The base ` +
                `URL, paths, and stats describe the whole wiki, so review them by hand.`
        );
    }

    // Fold a language script path into the base URL (example.fandom.com/es)
    // Fold farms accept any shape (a /lzh wiki can report lang=zh-tw)
    const farm = farmFor(host);
    const folded =
        SCRIPT_PATH_LANG_RE.test(variant) &&
        (variant === fullLanguage.toLowerCase() || variant === baseLanguage || Boolean(farm?.fold));
    if (folded) {
        fullLanguage = variant;
        baseLanguage = variant.split("-")[0];
    }

    const relative = (path) => {
        if (folded && (path === scriptPath || path.startsWith(scriptPath + "/"))) {
            path = path.slice(scriptPath.length);
        }
        return path || "/";
    };

    const articlePath = generalStr(general, "articlepath", "/index.php?title=$1");
    let iconUrl = generalStr(general, "favicon") || generalStr(general, "logo") || null;
    if (iconUrl) {
        try {
            iconUrl = new URL(iconUrl, serverBase).href;
        } catch {
            iconUrl = null;
        }
    }

    const sitename = generalStr(general, "sitename");
    return Object.assign(profile, {
        name: cleanText(sitename),
        language: baseLanguage,
        fullLanguage,
        baseUrl: cleanText(folded ? host + scriptPath : host),
        contentPath: cleanText(relative(articlePath.split("$1")[0])),
        searchPath: cleanText(relative(generalStr(general, "script", scriptPath + "/index.php"))),
        mainPage: cleanText(generalStr(general, "mainpage")).replaceAll(" ", "_"),
        platform: "mediawiki",
        generator: cleanText(generalStr(general, "generator", "MediaWiki")),
        iconUrl,
        stats: data.query.statistics || {},
        official: OFFICIAL_RE.test(sitename),
        farm,
    });
}

function iconFilename(wikiName, baseUrl) {
    const name = wikiName.normalize("NFKD").toLowerCase().replaceAll("wiki.gg", "wiki");
    return (slug(name) || slug(baseHost(baseUrl)) || "wiki") + ".png";
}

const FARM_SUFFIX_RE = new RegExp(`[\\s_-]*(?:${ORIGIN_FARM_NAMES.join("|")})?[\\s_-]*wikia?$`, "i");

// Normalize to the data's "X Fandom Wiki" convention
function originName(name, farm) {
    if (!name || farm?.role !== "origin") return name;
    let stem = name.replace(FARM_SUFFIX_RE, "").trim();
    stem = stem.replace(/^wikia?[\s:_-]+/i, "").trim();
    return stem ? `${stem} ${farm.label} Wiki` : `${farm.label} Wiki`;
}

// Draft sites entry
function buildEntry(origin, destination, language) {
    const topic = slug(origin.baseUrl.split(".")[0]);
    const label = originName(origin.name, origin.farm);

    const entry = {
        id: `${language}-${topic}`,
        origins_label: label,
        origins: [
            {
                origin: label,
                origin_base_url: origin.baseUrl,
                origin_content_path: origin.contentPath || null,
                origin_main_page: origin.mainPage || null,
            },
        ],
        destination: destination.name || null,
        destination_base_url: destination.baseUrl,
        destination_platform: destination.platform || null,
        destination_icon: iconFilename(destination.name, destination.baseUrl),
        destination_main_page: destination.mainPage || null,
        destination_search_path: destination.searchPath || null,
        destination_content_path: destination.contentPath || null,
    };
    if (destination.farm?.role === "destination") entry.destination_host = destination.farm.label;
    if (destination.official) entry.tags = ["official"];
    return entry;
}

// Compare the draft with the live data
async function checkAgainstData(entry, language) {
    const result = { warnings: [], existing: null, originListed: false };
    const file = sitesFile(language);

    let sites;
    try {
        sites = (await fetchJson(`${DATA_API}/${language}-data.json`)).sites;
    } catch {
        result.warnings.push(
            `There is no ${file} yet (or it could not be fetched); this may be the first ${language} wiki.`
        );
        return result;
    }
    if (!Array.isArray(sites)) return result;

    const originUrl = entry.origins[0].origin_base_url;
    const originEntry = sites.find((site) => (site.origins || []).some((o) => o.origin_base_url === originUrl));
    if (originEntry) {
        const lead =
            `${codeSpan(originUrl)} already redirects to ` +
            `${codeSpan(originEntry.destination_base_url)} (entry ${codeSpan(originEntry.id)})`;
        if (originEntry.destination_base_url === entry.destination_base_url) {
            result.originListed = true;
            result.warnings.push(`${lead}, so nothing may need to change.`);
        } else {
            result.warnings.push(
                `${lead}, not to the destination entered here. To change the destination, ` +
                    `edit or replace that entry rather than adding a second one.`
            );
        }
    }

    result.existing = sites.find((site) => site.destination_base_url === entry.destination_base_url) ?? null;
    if (result.existing) {
        result.warnings.push(
            `${codeSpan(entry.destination_base_url)} already has entry ` +
                `${codeSpan(result.existing.id)}. Append the origin to its \`origins\` list.`
        );
    }

    if (!result.existing && sites.some((site) => site.id === entry.id)) {
        result.warnings.push(`Entry ID ${codeSpan(entry.id)} is already in use; pick another topic name.`);
    }
    return result;
}

function formatStat(value) {
    return Number.isInteger(value) ? value.toLocaleString("en-US") : "—";
}

// Shared by the markdown site line and the page overview
function siteSummary(profile) {
    const parts = [profile.generator || "unknown software"];
    if (profile.farm) parts.push(`hosted on ${profile.farm.label}`);
    return {
        name: profile.name || "(name unknown)",
        // No link without a name, or when parens would break the markdown
        url: profile.name && !profile.url.includes("(") ? profile.url : null,
        detail: parts.join(", "),
    };
}

function siteLine(label, site) {
    const name = mdEscape(site.name);
    return `**${label}:** ${site.url ? `[${name}](${site.url})` : name} — ${mdEscape(site.detail)}`;
}

function hasNull(draft) {
    const values = Object.values(draft);
    for (const origin of draft.origins || []) values.push(...Object.values(origin));
    return values.includes(null);
}

// Warnings that need both profiles
function crossWarnings(origin, destination) {
    const warnings = [];
    const originHost = baseHost(origin.baseUrl);
    if (originHost && origin.farm?.role !== "origin") {
        warnings.push(
            `${codeSpan(originHost)} is not on a known origin farm (${ORIGIN_FARM_NAMES.join(", ")}); ` +
                `the data repo's checks reject entries whose origin lives elsewhere.`
        );
    }
    if (origin.fullLanguage && destination.fullLanguage && origin.fullLanguage !== destination.fullLanguage) {
        const sameBase = origin.language === destination.language;
        warnings.push(
            `The wikis ${sameBase ? "use different dialects" : "have different languages"}: ` +
                `origin is ${codeSpan(origin.fullLanguage)}, destination is ${codeSpan(destination.fullLanguage)}.`
        );
    }
    return warnings;
}

// Notes for a new entry
function newEntryNotes(destination, entry, language) {
    const notes = [];
    const icon = cleanText(destination.iconUrl, 300);
    let note = `Add the favicon as \`favicons/${language}/${entry.destination_icon}\` (16px PNG).`;
    if (icon) note += ` Source: ${codeSpan(icon)}`;
    notes.push(note);
    if (destination.official) {
        notes.push(
            'The destination calls itself "official", so the draft has the ' +
                "`official` tag. Remove it if that is wrong."
        );
    }
    return notes;
}

// Derived once so the page and the markdown cannot drift
function buildView(origin, destination, entry, dataResult, language) {
    const { existing = null, originListed = false, warnings: dataWarnings = [] } = dataResult ?? {};
    // The JSON to paste: a new entry, or one origin if the destination exists
    const draft = entry ? (existing ? entry.origins[0] : entry) : null;

    const notes = [];
    if (draft && hasNull(draft)) {
        notes.push("The tool could not determine the fields shown as `null`; fill them in by hand.");
    }
    if (entry && !existing) notes.push(...newEntryNotes(destination, entry, language));

    return {
        sites: [
            ["Origin", siteSummary(origin)],
            ["Destination", siteSummary(destination)],
        ],
        // Keep the committed filename when replacing an existing icon
        favicon:
            entry && destination.iconUrl
                ? {
                      url: ICON_PROXY + encodeURIComponent(destination.iconUrl),
                      name: existing?.destination_icon || entry.destination_icon,
                  }
                : null,
        statRows: STAT_ROWS.filter(([key]) => key in origin.stats || key in destination.stats).map(([key, label]) => [
            label,
            formatStat(origin.stats[key]),
            formatStat(destination.stats[key]),
        ]),
        warnings: [...origin.warnings, ...destination.warnings, ...dataWarnings, ...crossWarnings(origin, destination)],
        existing,
        draft,
        draftTitle: existing
            ? `Draft origin to ${originListed ? "compare with" : "append to"} ${codeSpan(existing.id)}`
            : "Draft entry",
        language,
        notes,
    };
}

function buildMarkdown(view, withJson) {
    const lines = [
        `<sub>Generated via [Indie Wiki Buddy wiki analysis tool](${TOOL_URL})</sub>`,
        "",
        "## Wiki comparison",
        "",
        ...view.sites.map(([label, site]) => siteLine(label, site)),
        "",
    ];

    if (view.statRows.length) {
        lines.push("| Statistic | Origin | Destination |", "| --- | ---: | ---: |");
        for (const row of view.statRows) lines.push(`| ${row.join(" | ")} |`);
        lines.push("");
    }

    if (view.warnings.length) {
        lines.push("### ⚠ Notes");
        for (const warning of view.warnings) lines.push(`- ${warning}`);
        lines.push("");
    }

    if (view.draft && withJson) {
        lines.push(`### ${view.draftTitle} ${view.existing ? "in" : "for"} \`${sitesFile(view.language)}\``);
        lines.push("```json", JSON.stringify(view.draft, null, 2), "```", "");
        for (const note of view.notes) lines.push(`- ${note}`);
    }

    return lines.join("\n").trimEnd();
}

const form = document.getElementById("form");
const originInput = document.getElementById("origin");
const destinationInput = document.getElementById("destination");
const submit = document.getElementById("submit");
const status = document.getElementById("status");
const results = document.getElementById("results");
const includeJson = document.getElementById("include-json");
const markdownBox = document.getElementById("markdown");
const overview = document.getElementById("overview");
const statsTable = document.getElementById("stats");
const statsBody = statsTable.querySelector("tbody");
const warningsBox = document.getElementById("warnings");
const warningsList = warningsBox.querySelector("ul");
const draftBox = document.getElementById("draft");
const draftTitle = document.getElementById("draft-title");
const draftJson = document.getElementById("draft-json");
const draftNotesBox = document.getElementById("draft-notes");
const includeJsonLabel = document.getElementById("include-json-label");
const faviconBox = document.getElementById("favicon");
const faviconActual = document.getElementById("favicon-actual");
const faviconDownload = document.getElementById("favicon-download");
const copyButton = document.getElementById("copy");
let lastView = null;
let faviconObjectUrl = null;

const params = new URLSearchParams(location.search);
originInput.value = params.get("origin") ?? "";
destinationInput.value = params.get("destination") ?? "";

function setStatus(text) {
    status.hidden = !text;
    status.textContent = text;
}

function renderOverviewLine(label, site) {
    const p = document.createElement("p");
    const strong = document.createElement("strong");
    strong.textContent = `${label}: `;
    p.append(strong);
    if (site.url) {
        const a = document.createElement("a");
        a.href = site.url;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = site.name;
        p.append(a);
    } else {
        p.append(site.name);
    }
    p.append(` — ${site.detail}`);
    return p;
}

function render(view) {
    overview.replaceChildren(...view.sites.map(([label, site]) => renderOverviewLine(label, site)));

    statsBody.replaceChildren();
    for (const row of view.statRows) {
        const tr = document.createElement("tr");
        for (const text of row) {
            const td = document.createElement("td");
            td.textContent = text;
            tr.append(td);
        }
        statsBody.append(tr);
    }
    statsTable.hidden = !view.statRows.length;

    warningsList.replaceChildren();
    for (const warning of view.warnings) {
        const li = document.createElement("li");
        li.textContent = plain(warning);
        warningsList.append(li);
    }
    warningsBox.hidden = !view.warnings.length;

    if (view.draft) {
        draftTitle.textContent = plain(view.draftTitle);
        draftJson.textContent = JSON.stringify(view.draft, null, 2);
        draftNotesBox.textContent = plain(view.notes.join(" "));
        draftBox.hidden = false;
    } else {
        draftBox.hidden = true;
    }

    includeJsonLabel.hidden = !view.draft;
    results.hidden = false;
}

function refreshMarkdown() {
    markdownBox.value = buildMarkdown(lastView, includeJson.checked);
}

// Show the converted favicon once it arrives
async function showFavicon(favicon) {
    faviconBox.hidden = true;
    if (faviconObjectUrl) URL.revokeObjectURL(faviconObjectUrl);
    faviconObjectUrl = null;
    if (!favicon) return;

    let blob;
    try {
        const response = await fetch(favicon.url);
        if (!response.ok) return;
        blob = await response.blob();
    } catch {
        return;
    }
    if (!blob.type.startsWith("image/")) return;

    faviconObjectUrl = URL.createObjectURL(blob);
    faviconActual.src = faviconObjectUrl;
    faviconDownload.href = faviconObjectUrl;
    faviconDownload.download = favicon.name;
    faviconDownload.textContent = `Download ${favicon.name}`;
    faviconBox.hidden = false;
}

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const originUrl = normalizeInputUrl(originInput.value);
    const destinationUrl = normalizeInputUrl(destinationInput.value);
    if (!originUrl || !destinationUrl) {
        setStatus("Both fields need a wiki URL.");
        return;
    }

    submit.disabled = true;
    results.hidden = true;
    try {
        setStatus("Checking both wikis…");
        const [origin, destination] = await Promise.all([profileWiki(originUrl), profileWiki(destinationUrl)]);

        let entry = null;
        let language = null;
        let dataResult = null;
        if (origin.baseUrl && destination.baseUrl) {
            language = origin.language || destination.language || "en";
            entry = buildEntry(origin, destination, language);
            setStatus("Checking against the Indie Wiki Buddy data…");
            dataResult = await checkAgainstData(entry, language);
        }

        lastView = buildView(origin, destination, entry, dataResult, language);
        render(lastView);
        refreshMarkdown();
        setStatus("");
        showFavicon(lastView.favicon);
    } catch (error) {
        setStatus(`Something went wrong: ${error.message || error}`);
    } finally {
        submit.disabled = false;
    }
});

includeJson.addEventListener("change", () => {
    if (lastView) refreshMarkdown();
});

copyButton.addEventListener("click", async () => {
    let message = "Copied!";
    try {
        await navigator.clipboard.writeText(markdownBox.value);
    } catch {
        message = "Copy failed";
    }
    copyButton.textContent = message;
    setTimeout(() => {
        copyButton.textContent = "Copy markdown";
    }, 1500);
});
