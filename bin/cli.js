#!/usr/bin/env node

import { program } from 'commander';
import chalk from 'chalk';
import { initCommand } from '../src/commands/init.js';
import { pullCommand } from '../src/commands/pull.js';
import { pushCommand } from '../src/commands/push.js';
import { statusCommand } from '../src/commands/status.js';
import { watchCommand } from '../src/commands/watch.js';
import { newCommand } from '../src/commands/new.js';
import { uploadCommand } from '../src/commands/upload.js';
import { forcePushCommand } from '../src/commands/force-push.js';
import { deleteCommand } from '../src/commands/delete.js';
import { checkForUpdates, getCurrentVersion } from '../src/utils/version-check.js';

// Check for updates in background
checkForUpdates();

program
  .name('wp-md')
  .description('WordPress content as markdown files for AI agents')
  .version(getCurrentVersion());

program
  .command('init [folder]')
  .description('Initialize configuration for a WordPress site')
  .action(initCommand);

program
  .command('pull')
  .description('Download content from WordPress')
  .option('-d, --dir <directory>', 'Content directory (default: current directory)')
  .option('-t, --type <type>', 'Post type: post, page, wp_template, wp_template_part, wp_block, wp_navigation, all', 'all')
  .option('--force', 'Overwrite local changes', false)
  .action(pullCommand);

program
  .command('push')
  .description('Upload local changes to WordPress')
  .option('-d, --dir <directory>', 'Content directory (default: current directory)')
  .option('-t, --type <type>', 'Content type to push', 'all')
  .option('-f, --file <file>', 'Specific file to push')
  .option('--dry-run', 'Show what would be pushed without making changes', false)
  .action(pushCommand);

program
  .command('status')
  .description('Show sync status between local files and WordPress')
  .option('-d, --dir <directory>', 'Content directory (default: current directory)')
  .action(statusCommand);

program
  .command('watch')
  .description('Watch for changes and sync automatically')
  .option('-d, --dir <directory>', 'Content directory (default: current directory)')
  .option('-a, --all', 'Watch all sites in current directory')
  .option('-s, --server', 'Start WebSocket server for browser extension')
  .option('--server-port <port>', 'WebSocket server port', '3456')
  .option('--debounce <ms>', 'Debounce delay in milliseconds', '1000')
  .option('-p, --poll <seconds>', 'Poll WordPress for changes every N seconds (0 to disable)', '0')
  .action(watchCommand);

program
  .command('new <type> [title]')
  .description('Create new content (draft) in WordPress and locally')
  .option('-d, --dir <directory>', 'Content directory (default: current directory)')
  .option('-p, --publish', 'Publish immediately instead of draft', false)
  .option('-c, --content <content>', 'Initial block content')
  .option('--area <area>', 'Template part area (header, footer, uncategorized)', 'uncategorized')
  .option('--parent <id>', 'Parent page ID', '0')
  .action(newCommand);

program
  .command('upload <file>')
  .description('Upload media file to WordPress')
  .option('-d, --dir <directory>', 'Content directory (default: current directory)')
  .option('-t, --title <title>', 'Media title')
  .option('-a, --alt <alt>', 'Alt text for images')
  .option('-c, --caption <caption>', 'Media caption')
  .action(uploadCommand);

program
  .command('force-push')
  .description('Push ALL local content to WordPress (creates missing entities)')
  .option('-d, --dir <directory>', 'Content directory (default: current directory)')
  .option('--dry-run', 'Show what would be pushed without making changes', false)
  .action(forcePushCommand);

program
  .command('delete <file>')
  .description('Delete a WordPress item and mark the local file as .deleted')
  .option('-d, --dir <directory>', 'Content directory (default: current directory)')
  .action(deleteCommand);

program.parse();
