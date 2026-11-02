import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, View } from 'react-native';
import Svg, { ClipPath, Defs, G, Path, Rect } from 'react-native-svg';
import { logo } from '../../../packages/design-tokens/src/index.ts';
import { usePalette } from './theme.ts';

const AnimatedRect = Animated.createAnimatedComponent(Rect);
const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedG = Animated.createAnimatedComponent(G);

// Mark-only viewBox in numbers, for the arrow's reveal rectangle.
const [MX, MY, MW, MH] = logo.viewBox.mark.split(' ').map(Number) as [number, number, number, number];
const [FX, FY, FW, FH] = logo.viewBox.full.split(' ').map(Number) as [number, number, number, number];

function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduce);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => sub.remove();
  }, []);
  return reduce;
}

// The relay moment: the mark settles, the arrow sweeps across it, then the wordmark follows letter
// by letter. Runs once on mount; Reduce Motion shows the finished logo immediately.
export function Logo({ variant = 'full', height }: { variant?: 'full' | 'mark'; height: number }) {
  const p = usePalette();
  const reduce = useReduceMotion();
  const mark = useRef(new Animated.Value(0)).current;
  const sweep = useRef(new Animated.Value(0)).current;
  const letters = useRef(logo.letters.map(() => new Animated.Value(0))).current;

  useEffect(() => {
    if (reduce) {
      mark.setValue(1);
      sweep.setValue(1);
      for (const l of letters) l.setValue(1);
      return;
    }
    const ease = Easing.bezier(0.2, 0.8, 0.2, 1);
    const anim = Animated.parallel([
      Animated.timing(mark, { toValue: 1, duration: 520, easing: ease, useNativeDriver: false }),
      Animated.timing(sweep, { toValue: 1, duration: 760, delay: 220, easing: Easing.bezier(0.65, 0, 0.35, 1), useNativeDriver: false }),
      Animated.stagger(
        40,
        letters.map((l) => Animated.timing(l, { toValue: 1, duration: 420, delay: 480, easing: ease, useNativeDriver: false })),
      ),
    ]);
    anim.start();
    return () => anim.stop();
  }, [reduce, mark, sweep, letters]);

  const vb = variant === 'full' ? logo.viewBox.full : logo.viewBox.mark;
  const [, , w, h] = variant === 'full' ? [FX, FY, FW, FH] : [MX, MY, MW, MH];
  const clipId = `wr-arrow-${variant}`;

  return (
    <View accessible accessibilityRole="image" accessibilityLabel="WotsRelay" style={{ height, aspectRatio: w / h }}>
      <Animated.View style={{ flex: 1, opacity: mark, transform: [{ scale: mark.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) }] }}>
        <Svg width="100%" height="100%" viewBox={vb}>
          <Defs>
            <ClipPath id={clipId}>
              <AnimatedRect x={MX} y={MY} height={MH} width={sweep.interpolate({ inputRange: [0, 1], outputRange: [0, MW] })} />
            </ClipPath>
          </Defs>
          <G fill={p.ink} fillRule="evenodd">
            <Path d={logo.mark} />
            <AnimatedPath d={logo.arrow} clipPath={`url(#${clipId})`} opacity={sweep.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0.2, 1, 1] })} />
            {variant === 'full'
              ? logo.letters.map((d, i) => (
                  <AnimatedG key={i} opacity={letters[i]!}>
                    <Path d={d} />
                  </AnimatedG>
                ))
              : null}
          </G>
        </Svg>
      </Animated.View>
    </View>
  );
}
