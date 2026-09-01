import type { Command } from '../bot/context.js';
import { helpCommand } from './help.js';
import { meCommand } from './me.js';
import { resetCommand } from './reset.js';
import { settingsCommand } from './settings.js';
import { usageCommand } from './usage.js';

export const commands: Command[] = [
  helpCommand,
  settingsCommand,
  meCommand,
  resetCommand,
  usageCommand,
];

export const commandsByName = new Map(commands.map((command) => [command.data.name, command]));

export function toCommandJSON(): unknown[] {
  return commands.map((command) => command.data.toJSON());
}
