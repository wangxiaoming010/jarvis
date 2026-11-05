import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { motion, type HTMLMotionProps, type Transition, type Variants } from 'motion/react';

/** One motion vocabulary for the whole desktop app (Motion, motion.dev).
 *  `easeSoft` is the S-curve used for entrances; springs drive anything the
 *  user directly moves (presses, highlights, layout shifts). */
export const easeSoft = [0.45, 0, 0.2, 1] as const;
const reducedMotionQuery = '(prefers-reduced-motion: reduce)';
function subscribeReducedMotion(listener: () => void) {
  const query = window.matchMedia(reducedMotionQuery);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}
const reducedMotion = () => window.matchMedia(reducedMotionQuery).matches;
export function useReducedMotionPreference() {
  return useSyncExternalStore(subscribeReducedMotion, reducedMotion, () => true);
}
export function loginDropTiming(index: number, variation: number): Transition {
  return {
    duration: 1.1 + variation * 0.25,
    delay: 0.08 + index * 0.075 + variation * 0.06,
    times: [0, 0.68, 0.82, 0.93, 1],
    ease: ['easeIn', 'easeOut', 'easeIn', 'easeOut'],
  };
}
// Delay is only set when given: an explicit 0 would override the stagger a
// parent assigns to its children.
export const soft = (duration = 0.46, delay?: number): Transition => ({
  duration,
  ease: easeSoft,
  ...(delay === undefined ? {} : { delay }),
});
export const spring: Transition = {
  type: 'spring',
  stiffness: 520,
  damping: 34,
  mass: 0.7,
};
export const springLayout: Transition = {
  type: 'spring',
  stiffness: 380,
  damping: 36,
};
export const botTiming = {
  curious: {
    duration: 5.6,
    times: [0, 0.12, 0.2, 0.24, 0.28, 0.5, 0.65, 1],
    repeat: Infinity,
    ease: easeSoft,
  } satisfies Transition,
  welcome: soft(0.8),
  feedback: soft(0.65),
  thinking: {
    duration: 1.7,
    repeat: Infinity,
    repeatDelay: 2.5,
    ease: easeSoft,
  } satisfies Transition,
  eyeDelay: 0.08,
};
/** iOS press scale: 1 - min(0.06, 4.5 / width). */
export const pressScale = (width: number) => 1 - Math.min(0.06, 4.5 / Math.max(width, 1));

export const rise: Variants = {
  hidden: { opacity: 0, y: 10 },
  shown: { opacity: 1, y: 0, transition: soft(0.42) },
};
export const fade: Variants = {
  hidden: { opacity: 0 },
  shown: { opacity: 1, transition: soft(0.24) },
  gone: { opacity: 0, transition: soft(0.16) },
};
export const pop: Variants = {
  hidden: { opacity: 0, scale: 0.96 },
  shown: { opacity: 1, scale: 1, transition: soft(0.26) },
  gone: { opacity: 0, scale: 0.97, transition: soft(0.16) },
};
/** Chat bubbles arrive from offset, scaled down and slightly blurred, and land
 *  sharp; the agent's bubbles are staggered by their parent. */
export const bubbleUser: Variants = {
  hidden: { opacity: 0, y: 18, scale: 0.92, filter: 'blur(3px)' },
  shown: {
    opacity: 1,
    y: 0,
    scale: 1,
    filter: 'blur(0px)',
    transition: soft(0.46),
  },
};
export const bubbleAgent: Variants = {
  hidden: { opacity: 0, y: 12, scale: 0.95, filter: 'blur(3px)' },
  shown: {
    opacity: 1,
    y: 0,
    scale: 1,
    filter: 'blur(0px)',
    transition: soft(0.52),
  },
};

/** Entrance gating: a Gate resolves once its own entrance has finished and
 *  every Gate above it has too, so charts can wait for the bubble and surface
 *  that contain them before drawing. */
const Entrance = createContext<Promise<void>>(Promise.resolve());
export const useEntrance = () => useContext(Entrance);
/** True once every enclosing Gate has finished its entrance. */
export function useEntered() {
  const entrance = useEntrance();
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    let live = true;
    void entrance.then(() => live && setEntered(true));
    return () => {
      live = false;
    };
  }, [entrance]);
  return entered;
}

export function Gate({
  children,
  initial,
  onAnimationComplete,
  ...props
}: HTMLMotionProps<'div'> & { children?: ReactNode }) {
  const parent = useEntrance();
  const [own] = useState(() => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  });
  const value = useMemo(
    () => Promise.all([parent, own.promise]).then(() => undefined),
    [parent, own],
  );
  useEffect(() => {
    if (initial === false) own.resolve();
    // Never hold content back if an entrance is interrupted.
    const timer = setTimeout(own.resolve, 2500);
    return () => clearTimeout(timer);
  }, []);
  return (
    <motion.div
      initial={initial}
      onAnimationComplete={(definition) => {
        own.resolve();
        onAnimationComplete?.(definition);
      }}
      {...props}
    >
      <Entrance.Provider value={value}>{children}</Entrance.Provider>
    </motion.div>
  );
}
