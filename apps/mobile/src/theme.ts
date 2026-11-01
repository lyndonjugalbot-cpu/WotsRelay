import { useColorScheme } from 'react-native';
import { color, laneFor, layout, space, type } from '../../../packages/design-tokens/src/index.ts';

export type Palette = (typeof color)['light'] | (typeof color)['dark'];

export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? color.dark : color.light;
}

export function laneColor(p: Palette, connectionId: string | null): string {
  return p[laneFor(connectionId)];
}

export { layout, space, type };
