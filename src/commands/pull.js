import { mkdir, writeFile, rename, access } from 'fs/promises';
import { join } from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { loadConfig, CONTENT_TYPES, TAXONOMY_TYPES, loadState, saveState, resolveContentDir } from '../config.js';
import { WordPressClient } from '../api/wordpress.js';
import { wpToMarkdown, mediaToMarkdown, taxonomyToMarkdown, wcProductToMarkdown, generateFilename, hashContent, THEME_FILES, extractThemeSection, themeSettingToMarkdown } from '../sync/content.js';

export async function pullCommand(options) {
  const dir = options.dir;
  const config = await loadConfig(dir);
  if (!config) {
    console.log(chalk.red('No configuration found. Run `wp-md init` first.'));
    return;
  }

  const client = new WordPressClient(config);
  const state = await loadState(dir);
  const contentDir = resolveContentDir(dir);

  const typesToPull = options.type === 'all'
    ? Object.keys(CONTENT_TYPES)
    : [options.type];

  console.log(chalk.bold('\n📥 Pulling content from WordPress\n'));

  let totalFiles = 0;
  let updatedFiles = 0;
  let newFiles = 0;
  let deletedFiles = 0;

  // Track which remote IDs were seen per type to detect deletions
  const pulledTypes = new Set();
  const remoteIds = {}; // type -> Set<id>

  for (const type of typesToPull) {
    const typeConfig = CONTENT_TYPES[type];
    if (!typeConfig) {
      console.log(chalk.yellow(`Unknown content type: ${type}`));
      continue;
    }

    const spinner = ora(`Fetching ${typeConfig.label}...`).start();

    try {
      // Special handling for global styles (split into multiple files)
      if (type === 'wp_global_styles') {
        const result = await pullGlobalStyles(client, contentDir, state, options.force);
        if (result.isNew) newFiles += result.filesCreated;
        else if (result.isChanged) updatedFiles++;
        totalFiles += result.filesCreated;
        pulledTypes.add(type);
        spinner.succeed(`${typeConfig.label}: ${result.filesCreated} files (${result.theme})`);
        continue;
      }

      // Special handling for WooCommerce products (use WC API for variations)
      if (type === 'product') {
        const result = await pullWcProducts(client, contentDir, state, options.force, spinner);
        newFiles += result.newFiles;
        updatedFiles += result.updatedFiles;
        totalFiles += result.totalFiles;
        if (result.remoteIds) {
          remoteIds[type] = result.remoteIds;
          pulledTypes.add(type);
        }
        spinner.succeed(`${typeConfig.label}: ${result.totalFiles} items (${result.variableCount} variable)`);
        continue;
      }

      const items = await client.fetchAll(type);
      spinner.text = `Processing ${items.length} ${typeConfig.label.toLowerCase()}...`;

      const typeDir = join(contentDir, typeConfig.folder);
      await mkdir(typeDir, { recursive: true });

      remoteIds[type] = new Set(items.map(i => i.id));
      pulledTypes.add(type);

      for (const item of items) {
        const filename = generateFilename(item);
        const filepath = join(typeDir, filename);
        const relativePath = join(typeConfig.folder, filename);

        // Use mediaToMarkdown for attachments, wpToMarkdown for others
        const markdown = typeConfig.isMedia
          ? mediaToMarkdown(item)
          : wpToMarkdown(item, type);
        const hash = hashContent(markdown);

        const existingState = state.files[relativePath];
        const isNew = !existingState;
        const isChanged = existingState && existingState.remoteHash !== hash;

        if (isNew || isChanged || options.force) {
          await writeFile(filepath, markdown);

          state.files[relativePath] = {
            id: item.id,
            type: type,
            localHash: hash,
            remoteHash: hash,
            lastSync: new Date().toISOString(),
          };

          if (isNew) newFiles++;
          else if (isChanged) updatedFiles++;
        }

        totalFiles++;
      }

      spinner.succeed(`${typeConfig.label}: ${items.length} items`);
    } catch (error) {
      spinner.fail(`${typeConfig.label}: ${error.message}`);
    }
  }

  // Pull taxonomies if requested
  const taxonomiesToPull = options.type === 'all'
    ? Object.keys(TAXONOMY_TYPES)
    : Object.keys(TAXONOMY_TYPES).filter(t => t === options.type);

  for (const taxonomy of taxonomiesToPull) {
    const taxConfig = TAXONOMY_TYPES[taxonomy];
    if (!taxConfig) continue;

    const spinner = ora(`Fetching ${taxConfig.label}...`).start();

    try {
      const items = await client.fetchAllTaxonomy(taxonomy);

      if (items.length === 0) {
        spinner.info(`${taxConfig.label}: 0 items (or not available)`);
        continue;
      }

      spinner.text = `Processing ${items.length} ${taxConfig.label.toLowerCase()}...`;

      const taxDir = join(contentDir, taxConfig.folder);
      await mkdir(taxDir, { recursive: true });

      remoteIds[taxonomy] = new Set(items.map(i => i.id));
      pulledTypes.add(taxonomy);

      for (const item of items) {
        const filename = `${item.slug}.md`;
        const filepath = join(taxDir, filename);
        const relativePath = join(taxConfig.folder, filename);

        const markdown = taxonomyToMarkdown(item, taxonomy);
        const hash = hashContent(markdown);

        const existingState = state.files[relativePath];
        const isNew = !existingState;
        const isChanged = existingState && existingState.remoteHash !== hash;

        if (isNew || isChanged || options.force) {
          await writeFile(filepath, markdown);

          state.files[relativePath] = {
            id: item.id,
            type: taxonomy,
            localHash: hash,
            remoteHash: hash,
            lastSync: new Date().toISOString(),
          };

          if (isNew) newFiles++;
          else if (isChanged) updatedFiles++;
        }

        totalFiles++;
      }

      spinner.succeed(`${taxConfig.label}: ${items.length} items`);
    } catch (error) {
      spinner.fail(`${taxConfig.label}: ${error.message}`);
    }
  }

  // Detect remote deletions: any tracked file whose type was pulled but whose
  // ID is no longer present in WordPress should be marked as deleted locally.
  const deleted = await markRemotelyDeletedFiles(contentDir, state, pulledTypes, remoteIds);
  deletedFiles = deleted;

  state.lastSync = new Date().toISOString();
  await saveState(state, dir);

  console.log(chalk.bold('\n📊 Summary'));
  console.log(`   Total: ${totalFiles} files`);
  console.log(`   New: ${chalk.green(newFiles)}`);
  console.log(`   Updated: ${chalk.yellow(updatedFiles)}`);
  if (deletedFiles > 0) {
    console.log(`   Deleted remotely: ${chalk.red(deletedFiles)} (marked as .deleted locally)`);
  }
  console.log(`   Unchanged: ${chalk.dim(totalFiles - newFiles - updatedFiles - deletedFiles)}`);
  console.log('');
}

/**
 * For each tracked file whose type was fully pulled, check if its WordPress ID
 * still appears in the remote set. If not, rename the local file to .deleted.
 */
async function markRemotelyDeletedFiles(contentDir, state, pulledTypes, remoteIds) {
  let count = 0;

  for (const [relativePath, entry] of Object.entries(state.files)) {
    // Skip already-deleted entries and special/untracked types
    if (entry.deleted) continue;
    if (!entry.type || !entry.id) continue;
    if (!pulledTypes.has(entry.type)) continue;

    // wp_global_styles entries don't have simple ID-based deletion tracking
    if (entry.type === 'wp_global_styles') continue;

    const ids = remoteIds[entry.type];
    if (!ids || ids.has(entry.id)) continue;

    // This item no longer exists in WordPress — mark local file as deleted
    const filepath = join(contentDir, relativePath);
    const deletedPath = filepath + '.deleted';

    try {
      await access(filepath);
      await rename(filepath, deletedPath);
      console.log(chalk.red(`  Deleted remotely: ${relativePath} → ${relativePath}.deleted`));
    } catch {
      // Local file may already be missing or renamed; still update state
    }

    // Update state
    delete state.files[relativePath];
    state.files[relativePath + '.deleted'] = {
      ...entry,
      deleted: true,
      deletedAt: new Date().toISOString(),
    };

    count++;
  }

  return count;
}

async function pullGlobalStyles(client, contentDir, state, force) {
  const globalStyles = await client.fetchGlobalStyles();

  const themeDir = join(contentDir, 'theme');
  await mkdir(themeDir, { recursive: true });

  let filesCreated = 0;
  let isNew = false;
  let isChanged = false;

  // Create separate files for each theme section
  for (const key of Object.keys(THEME_FILES)) {
    const sectionData = extractThemeSection(globalStyles, key);
    if (!sectionData) continue;

    const markdown = themeSettingToMarkdown(key, sectionData, globalStyles.id, globalStyles.theme);
    if (!markdown) continue;

    const filename = `${key}.md`;
    const filepath = join(themeDir, filename);
    const relativePath = join('theme', filename);
    const hash = hashContent(markdown);

    const existingState = state.files[relativePath];
    const fileIsNew = !existingState;
    const fileIsChanged = existingState && existingState.remoteHash !== hash;

    if (fileIsNew) isNew = true;
    if (fileIsChanged) isChanged = true;

    if (fileIsNew || fileIsChanged || force) {
      await writeFile(filepath, markdown);

      state.files[relativePath] = {
        id: globalStyles.id,
        type: 'wp_global_styles',
        section: key,
        theme: globalStyles.theme,
        localHash: hash,
        remoteHash: hash,
        lastSync: new Date().toISOString(),
      };
    }

    filesCreated++;
  }

  return {
    success: true,
    theme: globalStyles.theme,
    filesCreated,
    isNew,
    isChanged,
  };
}

async function pullWcProducts(client, contentDir, state, force, spinner) {
  const result = {
    totalFiles: 0,
    newFiles: 0,
    updatedFiles: 0,
    variableCount: 0,
    remoteIds: null,
  };

  // Check if WooCommerce is available
  const hasWc = await client.hasWooCommerce();
  if (!hasWc) {
    // Fall back to standard WP REST API (without variations)
    return result;
  }

  const typeConfig = CONTENT_TYPES.product;
  const typeDir = join(contentDir, typeConfig.folder);
  await mkdir(typeDir, { recursive: true });

  spinner.text = 'Fetching products via WooCommerce API...';
  const products = await client.fetchWcProducts();

  result.remoteIds = new Set(products.map(p => p.id));

  for (const product of products) {
    spinner.text = `Processing ${product.name}...`;

    // Fetch variations for variable products
    let variations = [];
    if (product.type === 'variable') {
      result.variableCount++;
      variations = await client.fetchProductVariations(product.id);
    }

    const filename = `${product.slug}.md`;
    const filepath = join(typeDir, filename);
    const relativePath = join(typeConfig.folder, filename);

    const markdown = wcProductToMarkdown(product, variations);
    const hash = hashContent(markdown);

    const existingState = state.files[relativePath];
    const isNew = !existingState;
    const isChanged = existingState && existingState.remoteHash !== hash;

    if (isNew || isChanged || force) {
      await writeFile(filepath, markdown);

      state.files[relativePath] = {
        id: product.id,
        type: 'product',
        localHash: hash,
        remoteHash: hash,
        lastSync: new Date().toISOString(),
      };

      if (isNew) result.newFiles++;
      else if (isChanged) result.updatedFiles++;
    }

    result.totalFiles++;
  }

  return result;
}
