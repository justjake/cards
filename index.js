require("dotenv").config({
  path: process.env.CONFIG,
  debug: Boolean(process.env.CONFIG),
});
const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const fsPromises = fs.promises;
const https = require("https");
const path = require("path");
const emoji = require("node-emoji");
const emojiUnicode = require("emoji-unicode");
const forEachRow = require("notion-for-each-row");
const katex = require("katex");
const Prism = require("prismjs");
const loadLanguages = require("prismjs/components/");
const mimeTypes = require("mime-types");
const { CMS, NotionClient, richTextAsPlainText } = require("@jitl/notion-api");

/** @typedef {import('@notionhq/client/build/src/api-endpoints').GetBlockResponse } GetBlockResponse */
/** @typedef {Extract<GetBlockResponse, { type: string }>} Block */
/** @typedef {Extract<Block, {type: "paragraph"}>["paragraph"]["text"][number] } RichText */
/** @typedef {import('@notionhq/client/build/src/api-endpoints').GetPageResponse } Page */

loadLanguages([
  "ocaml",
  "scheme",
  "diff",
  "shell",
  "docker",
  "typescript",
  "prolog",
]);

/**
 * Accessors for our env var configurations
 * Override these!
 */
const settings = new (class Settings {
  get twitterHandle() {
    return process.env.TWITTER_HANDLE || "jdan";
  }

  get ogImage() {
    return process.env.OG_IMAGE || "https://cards.jordanscales.com/me.png";
  }

  get baseUrl() {
    return process.env.BASE_URL || "/";
  }

  get outputDir() {
    return (
      process.env.BUILD ||
      path.join(
        __dirname,
        "build",
        this.baseUrl[0] === "/" ? this.baseUrl.slice(1) : "."
      )
    );
  }

  get notionSecret() {
    const { NOTION_SECRET } = process.env;
    if (!NOTION_SECRET) {
      throw new Error("Missing NOTION_SECRET env variable");
    }
    return NOTION_SECRET;
  }

  get notionDatabaseId() {
    const { NOTION_DATABASE_ID } = process.env;
    if (!NOTION_DATABASE_ID) {
      throw new Error("Missing NOTION_DATABASE_ID env variable");
    }
    return NOTION_DATABASE_ID;
  }

  /**
   * @param {string} part
   */
  url(part) {
    return path.join(this.baseUrl, part);
  }

  /**
   * @param {string} part
   */
  output(part) {
    return path.join(this.outputDir, part);
  }

  info() {
    return {
      outputDir: this.outputDir,
      baseUrl: this.baseUrl,
      notionDatabaseId: this.notionDatabaseId,
      twitterHandle: this.twitterHandle,
      ogImage: this.ogImage,
    };
  }
})();

const cms = new CMS({
  database_id: settings.notionDatabaseId,
  notion: new NotionClient({ auth: settings.notionSecret }),
  title: {
    type: "property",
    property: {
      name: "Name",
      propertyType: "title",
    },
  },
  slug: {
    type: "derived",
    derive(page) {
      const id = page.id;
      const /** @type {any} */ properties = page.properties;
      return (
        (properties.Filename
          ? concatenateText(properties.Filename.rich_text)
          : "") || `${id.replace(/-/g, "").slice(0, 8)}.html`
      );
    },
  },
  customProperties: {},
  visible: true,
  assets: {
    directory: settings.outputDir,
    downloadExternalAssets: true,
  },
  cache: {
    directory: settings.output("cache"),
  },
});

// We preload all blocks in every page then transform the block data model so
// that each block has a children array containing its children.
//
// We also group some kinds of blocks together into new synthetic block groups.
// This allows more straightforward rendering of ordered and unordered list
// blocks.

/**
 * A branch in a tree where each Branch can have children of either Leaf or more
 * recursive branches.
 *
 * @template Branch
 * @template [Leaf=never]
 * @typedef {Branch & { children: Array<Leaf | RecursiveBranch<Branch, Leaf>> }} RecursiveBranch
 */

/**
 * A recursive tree with branches and leaves of different types.
 * This is used to define our recursive block structure.
 *
 * @template Branch
 * @template [Leaf=never]
 * @typedef {RecursiveBranch<Branch, Leaf> | Leaf} RecursiveTree
 */

/**
 * A block-like object containing only blocks of type `BlockType`.
 *
 * @template {Block["type"]} BlockType
 * @template {string} GroupType
 * @typedef {{
  id: string;
  type: GroupType;
  has_children: true;
  children: Array<Extract<Block, { type: BlockType }> & { children: CardBlock[] }>;
 }} BlockGroup
 */

/**
  * All the block groups we make.
  *
  @typedef {
    | BlockGroup<"numbered_list_item", "numbered_list">
    | BlockGroup<"bulleted_list_item", "bulleted_list">
  } CardBlockGroup
  */

/**
 * @typedef {CardBlockGroup["children"][number]["type"]} GroupedBlockType
 * @typedef {Exclude<Block, { type: GroupedBlockType }>} UngroupedBlock
 */

/**
 * Our extended Block type that forms a recursive tree of blocks.
 *
 * @typedef {RecursiveTree<UngroupedBlock, CardBlockGroup> | CardBlockGroup["children"][number]} CardBlock
 */

/**
 * A Card is based on a Notion page.
 *
 * @typedef {{
    id: string,
    headingIcon: string | null,
    favicon: string,
    title: string,
    blocks: CardBlock[]
    filename: string
    content?: string
  }} CardPage
*/

const sha = childProcess
  .execSync("git rev-parse HEAD", { cwd: __dirname })
  .toString()
  .trim();
let id = 1;
function getDeterministicUUID() {
  const shasum = crypto.createHash("sha1");
  shasum.update(sha);
  shasum.update("" + id++);
  return addDashes(shasum.digest("hex"));
}

/**
 * @param {string} id a UUID string
 */
function addDashes(id) {
  return [
    id.slice(0, 8),
    id.slice(8, 12),
    id.slice(12, 16),
    id.slice(16, 20),
    id.slice(20, 32),
  ].join("-");
}

/**
 * @param {Array<RichText> | undefined} arr
 */
function concatenateText(arr) {
  if (arr) {
    return arr.map((i) => i.plain_text).join("");
  } else {
    return "";
  }
}

/** @param {string} str containing an ISO *date*, eg yyyy-mm-dd */
function relativeDate(str) {
  const [year, month, day] = str.split("-").map((i) => parseInt(i));

  const date = new Date();
  date.setFullYear(year);
  date.setMonth(month - 1);
  date.setDate(day);

  const deltaDays = Math.round(
    (date.getTime() - Date.now()) / (1000 * 3600 * 24)
  );

  const relative = new Intl.RelativeTimeFormat("en", {
    numeric: "auto",
  });

  const formatted = relative.format(deltaDays, "days");
  return formatted[0].toUpperCase() + formatted.slice(1);
}

/**
 * @param {string} pageId uuid of a page
 * @param { RichText } text
 * @param {any} allPages
 */
async function textToHtml(pageId, text, allPages) {
  if (text.type === "text") {
    const codeFriendly = text.text.content
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    /** @type {Set<string>} */ const emojiToLoad = new Set([]);
    let content = emoji.replace(codeFriendly, ({ emoji }) => {
      emojiToLoad.add(emoji);
      return emoji;
    });

    await Promise.all(
      [...emojiToLoad].map(async (emoji) => {
        const filename = await saveEmojiFavicon(emoji);
        // Hmmmm safe?
        content = content.replace(
          new RegExp(emoji, "ug"),
          `<img class="emoji" alt="${emoji}" src="${filename}" />`
        );
      })
    );

    if (text.annotations.bold) {
      content = `<strong>${content}</strong>`;
    }
    if (text.annotations.italic) {
      content = `<em>${content}</em>`;
    }
    if (text.annotations.underline) {
      content = `<u>${content}</u>`;
    }
    if (text.annotations.strikethrough) {
      content = `<strike>${content}</strike>`;
    }
    if (text.annotations.code) {
      content = `<code>${content}</code>`;
    }

    if (text.text.link) {
      // Links to other pages (not mentions), should also get back-linked
      if (/^\//.test(text.text.link.url)) {
        const id = text.text.link.url.slice(1);
        // Hack: format into "c3d85220-62aa-457a-b414-90c5e9929790"

        const backlinkFriendlyId = addDashes(id);

        registerBacklink(pageId, backlinkFriendlyId);
        return linkOfId(allPages, backlinkFriendlyId, {
          overwriteTitle: content,
        });
      } else {
        return `<a href="${text.text.link.url}">${content}</a>`;
      }
    } else {
      return content;
    }
  } else if (text.type === "mention") {
    if (text.mention.type === "page") {
      registerBacklink(pageId, text.mention.page.id);
      return linkOfId(allPages, text.mention.page.id);
    } else if (text.mention.type === "date") {
      const { start } = text.mention.date;

      if (start && /^\d{4}-\d{2}-\d{2}$/.test(start)) {
        return relativeDate(start);
      } else if (start) {
        const [date, time] = start.slice(0, 16).split("T");

        const options = /** @type {const} */ ({
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        const longDate = new Intl.DateTimeFormat("en-US", options).format(
          new Date(date)
        );
        return `${longDate} – ${time}`;
      }
    } else {
      console.log("Unrecognized mention --", text);
    }
  } else if (text.type === "equation") {
    return katex.renderToString(text.equation.expression);
  } else {
    console.log("Unrecognized text --", text);
  }
}

async function copyStaticAssets() {
  const assets = [
    path.join(__dirname, "public/style.css"),
    path.join(__dirname, "public/me.png"),
    path.join(__dirname, "node_modules/prismjs/themes/prism-coy.css"),
    path.join(__dirname, "node_modules/prismjs/themes/prism-tomorrow.css"),
    path.join(__dirname, "node_modules/katex/dist/katex.min.css"),
  ];
  return Promise.all(
    assets.map(async (asset) =>
      fsPromises.copyFile(asset, settings.output(path.basename(asset)))
    )
  );
}

/**
 *
 * @param {CardPage[]} allPages
 * @param {string} id
 * @param {{ overwriteTitle?: string }} args
 * @returns
 */
const linkOfId = (allPages, id, args = {}) => {
  const page = allPages.find((entry) => entry.id === id);
  if (page) {
    return `<a href="${settings.url(page.filename)}"${
      page.favicon ? ` class="with-emoji"` : ""
    }>
      ${
        page.favicon
          ? `<img class="emoji" alt="" src="${settings.url(page.favicon)}">`
          : ""
      }
      ${args.overwriteTitle || page.title}</a>`;
  } else {
    return `[${id}]`;
  }
};

/**
 *
 * @param {CardPage} page
 * @param {typeof backlinks} backlinks
 * @param {CardPage[]} allPages
 */
async function savePage(
  { id, title, favicon, headingIcon, content, filename },
  backlinks,
  allPages
) {
  const icon = favicon || (await saveEmojiFavicon("💡"));

  const footer = backlinks[id]
    ? `<footer><label>mentioned in</label><ul>${backlinks[id]
        .sort()
        .map((id) => `<li>${linkOfId(allPages, id)}</li>`)
        .join("\n")}</ul></footer>`
    : "";

  const script = await fsPromises.readFile(
    path.join(__dirname, "public/script.js")
  );

  const body = `
    <!doctype html>
    <html lang="en">
    <head>
      <title>${title}</title>
      <link rel="Shortcut Icon" type="image/x-icon" href="${settings.url(
        icon
      )}" />
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">

      <meta property="og:title" content="${title}" />
      <meta property="og:image" content="${settings.ogImage}" />

      <meta name="twitter:card" content="summary" />
      <meta name="twitter:site" content="${settings.twitterHandle}" />
      <meta name="twitter:title" content="${title}" />

      <link rel="stylesheet" href="${settings.url("style.css")}">
      <link rel="preload" href="${settings.url("prism-coy.css")}" as="style">
      <link rel="preload" href="${settings.url(
        "prism-tomorrow.css"
      )}" as="style">
      <link id="prism" rel="stylesheet" href=${settings.url("prism-coy.css")}">
      <link rel="stylesheet" href=${settings.url("katex.min.css")}>
    </head>
    <body>
      <script>0</script>
      <main class="p${id.slice(0, 8)}">
        <header>
          <a href="${settings.baseUrl}">Home</a>
          <button id="toggle-btn" aria-label="enable dark theme">🌙</button>
        </header>
        ${
          headingIcon
            ? `<div class="title-row">
                ${headingIcon}
                <h1>${title}</h1>
              </div>`
            : `<h1>${title}</h1>`
        }
        ${content}
        ${footer}
      </main>
      <script>${script}</script>
    </body>
    </html>
  `;
  await fsPromises.writeFile(settings.output(filename), body);
}

/**
 * @param {string} url
 * @param {string} filenamePrefix
 * @returns Promise<string | undefined>
 */
async function downloadImage(url, filenamePrefix) {
  const files = await fsPromises.readdir(settings.outputDir);
  let filename = files.find((name) => name.startsWith(filenamePrefix));

  if (!filename) {
    return new Promise((resolve) => {
      https.get(url, (res) => {
        const ext = mimeTypes.extension(
          res.headers["content-type"] || "image/png"
        );
        const dest = `${filenamePrefix}.${ext}`;
        const destStream = fs.createWriteStream(settings.output(dest));
        res
          .pipe(destStream)
          .on("finish", () => {
            resolve(dest);
          })
          .on("error", () => {
            console.log("Image failed to write", dest);
            resolve(undefined);
          });
      });
    });
  } else {
    return filename;
  }
}

/**
 *
 * @param {Block & { type: "image"}} block
 * @param {string} blockId
 * @returns Promise<string | undefined>
 */
async function downloadImageBlock(block, blockId) {
  const filename = await downloadImage(
    block.image.type === "file"
      ? block.image.file.url
      : block.image.external.url,
    `${block.id}.image`
  );

  if (!filename) {
    return;
  }

  const caption = concatenateText(block.image.caption);
  const html = `<figure id="${blockId}">
      <img alt="${caption}" src="${settings.url(filename)}">
      <figcaption>${caption}</figcaption>
    </figure>`;

  return html;
}

/**
 *
 * @param {CardBlock} block
 * @param {string} pageId
 * @param {CardPage[]} allPages
 * @returns {Promise<string | undefined>}
 */
async function blockToHtml(block, pageId, allPages) {
  /**
   * @param {RichText[]} texts
   * @returns
   */
  const textToHtml_ = async (texts) => {
    const converts = await Promise.all(
      texts.map((text) => textToHtml(pageId, text, allPages))
    );
    return converts.join("");
  };
  const blockId = "b" + block.id.replace(/-/g, "").slice(0, 8);
  const children = await Promise.all(
    block.children.map((block) => blockToHtml(block, pageId, allPages))
  );

  if (block.type === "bulleted_list") {
    return `<ul id="${blockId}">${children.join("\n")}</ul>`;
  } else if (block.type === "numbered_list") {
    return `<ol id="${blockId}">${children.join("\n")}</ol>`;
  } else if (block.type === "bulleted_list_item") {
    return `<li id="${blockId}">
      <div class="list-item">
        ${await textToHtml_(block.bulleted_list_item.text)}
      </div>
      ${children.join("\n")}
    </li>`;
  } else if (block.type === "numbered_list_item") {
    return `<li id="${blockId}">
      <div class="list-item">
        ${await textToHtml_(block.numbered_list_item.text)}
      </div>
      ${children.join("\n")}
    </li>`;
  } else if (block.type === "paragraph") {
    return `<div class="text" id="${blockId}">
      ${await textToHtml_(block.paragraph.text)}
      <div class="children">${children.join("\n")}</div>
    </div>`;
  } else if (block.type === "heading_1") {
    return `<h1 id="${blockId}">${await textToHtml_(
      block.heading_1.text
    )}</h1>`;
  } else if (block.type === "heading_2") {
    return `<h2 id="${blockId}">${await textToHtml_(
      block.heading_2.text
    )}</h2>`;
  } else if (block.type === "heading_3") {
    return `<h3 id="${blockId}">${await textToHtml_(
      block.heading_3.text
    )}</h3>`;
  } else if (block.type === "toggle") {
    return `<details id="${blockId}"><summary>${await textToHtml_(
      block.toggle.text
    )}</summary>${children.join("\n")}</details>`;
  } else if (block.type === "code") {
    const language = block.code.language.toLowerCase();
    if (language !== "plain text" && !Prism.languages[language]) {
      console.log("Unrecognized language --", language);
    }
    const code = Prism.languages[language]
      ? Prism.highlight(
          concatenateText(block.code.text),
          Prism.languages[language],
          language
        )
      : concatenateText(block.code.text);
    return `<pre id="${blockId}"><code class="language-${language.replace(
      /\s/g,
      "-"
    )}">${code}</code></pre>`;
  } else if (block.type === "equation") {
    return katex.renderToString(block.equation.expression, {
      displayMode: true,
    });
  } else if (block.type === "image") {
    if (block.image.type === "file") {
      return downloadImageBlock(block, blockId);
    } else if (block.image.type === "external") {
      const caption = concatenateText(block.image.caption);
      return `<figure id="${blockId}">
        <img alt="${caption}" src="${block.image.external.url}">
        <figcaption>${caption}</figcaption>
      </figure>`;
    } else {
      console.log("Unrecognized image", block);
    }
  } else if (block.type === "to_do") {
    return `<div><label>
      <input type="checkbox" onclick="return false" ${
        block.to_do.checked ? "checked" : ""
      }>
      ${await textToHtml_(block.to_do.text)}
    </label></div>`;
  } else if (block.type === "quote") {
    return `<blockquote>
      <p>${await textToHtml_(block.quote.text)}</p>
      ${children.join("\n")}
    </blockquote>`;
  } else if (block.type === "divider") {
    return "<hr />";
  } else if (block.type === "unsupported") {
    return "[unsupported]";
  } else {
    console.log("Unrecognized block --", block);
  }
}

/**
 * Group adjacent runs of `blocks` that have `type` into a new synthetic block
 * with type `result_type`. `blocks` is recursively mutated to have the grouping.
 *
 * @template {GroupedBlockType} BlockType
 * @template {CardBlockGroup["type"]} GroupType
 * @param {RecursiveTree<Block>[] | CardBlock[]} blocks
 * @param {BlockType} type
 * @param {GroupType} result_type
 * @returns {CardBlock[]}
 */
function groupAdjacentBlocksRecursively(blocks, type, result_type) {
  /** @typedef {BlockGroup<BlockType, GroupType>} ResultGroup */
  /** @typedef {ResultGroup["children"][number]} BlockToGroup */
  /** @type {CardBlock[]} */ let result = [];
  /** @type {BlockToGroup[]} */ let currentList = [];
  const blocksAsCardBlocks = /** @type {CardBlock[]} */ (blocks);

  blocks.forEach((block, i) => {
    if (block.has_children) {
      // Recursively apply grouping to each block's children.
      blocksAsCardBlocks[i].children = groupAdjacentBlocksRecursively(
        block.children,
        type,
        result_type
      );
    }

    if (block.type === type) {
      // This kind of generic type constraint is impossible to express in TS
      // since there's no way to declare that { type: XXXX } is a discriminated
      // union (it could always be declared as `string`).
      // See https://stackoverflow.com/questions/50870423/discriminated-union-of-generic-type
      currentList.push(/** @type {BlockToGroup} */ (block));
    } else {
      if (currentList.length) {
        /** @type {ResultGroup} */ const group = {
          id: getDeterministicUUID(),
          has_children: true,
          type: result_type,
          children: currentList,
        };
        result.push(/** @type {CardBlock} */ (group));
        currentList = [];
      }

      result.push(blocksAsCardBlocks[i]);
    }
  });

  if (currentList.length) {
    /** @type {ResultGroup} */ const group = {
      id: getDeterministicUUID(),
      has_children: true,
      type: result_type,
      children: currentList,
    };
    result.push(/** @type {CardBlock} */ (group));
  }

  return result;
}

/** @type {Record<string, string[]>} */
const backlinks = {};
const registerBacklink = (
  /** @type {string} */ sourceId,
  /** @type {string} */ destinationId
) => {
  if (backlinks[destinationId]) {
    backlinks[destinationId].push(sourceId);
  } else {
    backlinks[destinationId] = [sourceId];
  }
};

/**
 * @param {NotionClient} notion Notion API client
 * @param {string} id Notion page ID
 */
async function getAllChildBlocks(notion, id) {
  const blocks = [];

  let next_cursor = undefined;
  let has_more = true;
  /** @type {Array<GetBlockResponse>} */ let results;

  while (has_more) {
    ({ results, has_more, next_cursor } = await notion.blocks.children.list({
      block_id: id,
      start_cursor: next_cursor || undefined,
    }));
    blocks.push(...results);
  }

  return blocks;
}

/**
 *
 * @param {NotionClient} notion
 * @param {string} id
 * @returns
 */
async function getChildren(notion, id) {
  const blocks = /** @type {RecursiveTree<Block>[]} */ (
    await getAllChildBlocks(notion, id)
  );
  return Promise.all(
    blocks.map(async (block) => {
      if (block.has_children) {
        block.children = await getChildren(notion, block.id);
      } else {
        block.children = [];
      }
      return block;
    })
  );
}

/**
 * @param {string} pageId
 * @param {{type: "file", file: {url: string}} | {type: "emoji", emoji: string}} icon
 * @returns Promise<string>
 */
async function saveFavicon(pageId, icon) {
  if (icon && icon.type === "file") {
    return await downloadImage(icon.file.url, `${pageId}.icon`);
  } else if (icon && icon.type === "emoji") {
    return await saveEmojiFavicon(icon.emoji);
  }
}

/**
 * @param {string} emoji Unicode emoji character
 * @returns Promise<string>
 */
async function saveEmojiFavicon(emoji) {
  const codepoints = emojiUnicode(emoji).split(" ").join("-");
  const basename = `${codepoints}.png`;
  const filename = path.join(
    __dirname,
    "node_modules/emoji-datasource-apple/img/apple/64",
    basename
  );
  if (!fs.existsSync(filename)) {
    console.log("Unknown emoji --", emoji, codepoints);
  }
  const dest = settings.output(basename);
  if (!fs.existsSync(dest)) {
    await fsPromises.copyFile(filename, dest);
  }
  return basename;
}

const main = async function main() {
  console.log(settings.info());

  /** @type {CardPage[]} */ const pages = [];

  // Make sure settings.outputDir exists
  if (!fs.existsSync(settings.outputDir)) {
    await fsPromises.mkdir(settings.outputDir, { recursive: true });
  }

  for await (const page of cms.query()) {
    const notion = cms.config.notion;
    const { id, icon, properties } = page.content;

    const filename = page.frontmatter.slug;
    const title = richTextAsPlainText(page.frontmatter.title);
    const children = page.content.children;
    const favicon = await saveFavicon(id, icon);

    // headingIcon is generated here so it can have the
    // emoji character as its alt text.
    //
    // Probably better to just send the emoji down.
    const headingIcon = icon
      ? `<img width="32" height="32" alt="${
          icon.type === "emoji" ? icon.emoji : ""
        }" src="${settings.url(favicon)}" />`
      : null;

    const blocks = groupAdjacentBlocksRecursively(
      groupAdjacentBlocksRecursively(
        children,
        "numbered_list_item",
        "numbered_list"
      ),
      "bulleted_list_item",
      "bulleted_list"
    );

    pages.push({
      id,
      headingIcon,
      favicon,
      title,
      blocks,
      filename,
    });
  }

  await Promise.all(
    pages.map(async (page) => {
      const renderedBlocks = await Promise.all(
        page.blocks.map(async (block) => blockToHtml(block, page.id, pages))
      );
      page.content = renderedBlocks.join("");
    })
  );

  Promise.all([
    ...pages.map((page) => savePage(page, backlinks, pages)),
    copyStaticAssets(),
  ]);
};

(async () => {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
})();
