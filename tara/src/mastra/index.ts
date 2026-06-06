import { Mastra } from '@mastra/core';
import { taraAgent } from './agents/tara';

export const mastra = new Mastra({
  agents: { tara: taraAgent },
});
