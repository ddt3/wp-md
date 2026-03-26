import { rename, access } from 'fs/promises';
import { join, basename } from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { loadConfig, CONTENT_TYPES, loadState, saveState, resolveContentDir } from '../config.js';
import { WordPressClient } from '../api/wordpress.js';

export async function deleteCommand(file, options) {
  const dir = options.dir;
  const config = await loadConfig(dir);
  if (!config) {
    console.log(chalk.red('No configuration found. Run `wp-md init` first.'));
    return;
  }

  const client = new WordPressClient(config);
  const state = await loadState(dir);
  const contentDir = resolveContentDir(dir);

  // Resolve the file path relative to contentDir if not absolute
  let filepath;
  if (file.startsWith('/')) {
    filepath = file;
  } else {
    filepath = join(contentDir, file);
  }

  // Find matching state entry by filepath
  let relativePath = null;
  let stateEntry = null;

  for (const [relPath, entry] of Object.entries(state.files)) {
    const absPath = join(contentDir, relPath);
    if (absPath === filepath || relPath === file) {
      relativePath = relPath;
      stateEntry = entry;
      break;
    }
  }

  if (!stateEntry) {
    // Try to match by basename only when the input has no directory separator
    const fileBasename = basename(file);
    if (!file.includes('/') && !file.includes('\\')) {
      for (const [relPath, entry] of Object.entries(state.files)) {
        if (basename(relPath) === fileBasename) {
          relativePath = relPath;
          stateEntry = entry;
          filepath = join(contentDir, relPath);
          console.log(chalk.dim(`  Matched by filename: ${relPath}`));
          break;
        }
      }
    }
  }

  if (!stateEntry) {
    console.log(chalk.red(`No tracked file found for: ${file}`));
    console.log(chalk.dim('Make sure the file has been pulled from WordPress and is tracked in state.'));
    return;
  }

  const { id, type } = stateEntry;

  if (!id) {
    console.log(chalk.red(`No WordPress ID found in state for: ${relativePath}`));
    return;
  }

  const typeConfig = CONTENT_TYPES[type];
  const typeLabel = typeConfig ? typeConfig.label : type;

  console.log(chalk.bold(`\n🗑️  Deleting from WordPress\n`));
  console.log(`   File:  ${relativePath}`);
  console.log(`   Type:  ${typeLabel}`);
  console.log(`   ID:    ${id}\n`);

  // Verify the local file still exists (may already be .deleted)
  let localFileExists = false;
  try {
    await access(filepath);
    localFileExists = true;
  } catch {
    // Check if already renamed to .deleted
    try {
      await access(filepath + '.deleted');
      console.log(chalk.yellow(`Local file already marked as deleted: ${relativePath}.deleted`));
    } catch {
      console.log(chalk.yellow(`Local file not found: ${relativePath}`));
    }
  }

  const spinner = ora(`Deleting ${typeLabel} (ID: ${id}) from WordPress...`).start();

  try {
    await client.delete(type, id);
    spinner.succeed(`Deleted from WordPress (ID: ${id})`);
  } catch (error) {
    spinner.fail(`Failed to delete from WordPress: ${error.message}`);
    return;
  }

  // Rename local file to .deleted
  if (localFileExists) {
    const deletedPath = filepath + '.deleted';
    try {
      await rename(filepath, deletedPath);
      console.log(chalk.green(`✓ Renamed local file: ${relativePath} → ${basename(relativePath)}.deleted`));
    } catch (error) {
      console.log(chalk.yellow(`Warning: Could not rename local file: ${error.message}`));
    }
  }

  // Update state: mark as deleted (remove the active entry)
  delete state.files[relativePath];
  state.files[relativePath + '.deleted'] = {
    ...stateEntry,
    deleted: true,
    deletedAt: new Date().toISOString(),
  };

  await saveState(state, dir);

  console.log(chalk.bold('\n✅ Done\n'));
}
