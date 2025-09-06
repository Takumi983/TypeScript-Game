/** == The numbers in each comment indicate the order of implementation. == */

import "./style.css";

import {
    Observable,
    catchError,
    filter,
    fromEvent,
    interval,
    map,
    scan,
    switchMap,
    take,
    merge, // Added
    timer, // Added
    BehaviorSubject, // 12. Added
    withLatestFrom, // 12. Added
    tap, // 12. Added
} from "rxjs";
import { fromFetch } from "rxjs/fetch";

/** ==================== Constants ==================== */

const Viewport = {
    CANVAS_WIDTH: 600,
    CANVAS_HEIGHT: 400,
} as const;

const bird = {
    WIDTH: 42,
    HEIGHT: 30,
} as const;

const Constants = {
    PIPE_WIDTH: 50,
    PIPE_SPEED_PX_S: 150, // 6. Pipe horizontal speed in pixels per second
    TICK_RATE_MS: 16, // 1. Might need to change this!
} as const;

// 5. Physical constants for a flappy bird
const Physics = {
    GRAVITY: 1200,
    FLAP_VELOCITY: -350,
    TERMINAL_VEL: 600, // Upper bound velocity |v| <= 600
    BOUNCE_MIN: 220, // 7. Bounce lower bound
    BOUNCE_MAX: 420, // 7. Bounce upper bound
};

/** ==================== User input ==================== */

type Key = "Space";

/** ==================== Data Types ==================== */

/* -- 2. Entities (Game Data Types) -- */
// Represents a 2D vector (used for positions)
type Vec = Readonly<{ x: number; y: number }>;

// Represents the bird entity with position and vertical velocity
type Bird = Readonly<{
    pos: Vec; // Center position of the bird
    velY: number; // Vertical velocity (+ = downward)
}>;

// Represents a pipe obstacle with a vertical gap
type Pipe = Readonly<{
    id: number; // Unique identifier to match pipe with its SVG element
    x: number; // x-coordinate of the left side of the pipe
    gapY: number; // Vertical center of the gap
    gapH: number; // Height of the gap
    passed: boolean; // 9. If the bird has already passed this pipe
}>;

// 3. Represents a scheduled pipe spawn (parsed from CSV)
type SpawnSpec = Readonly<{
    gapY: number; // Vertical center of the gap (pixels)
    gapH: number; // Gap height (pixels)
    timeMs: number; // When the pipe should appear (ms from game start)
}>;

// 7. Collision Detection:
// -> Shared type for all rectangular hitboxes (Helper functions)
type Hitbox = Readonly<{
    left: number;
    right: number;
    top: number;
    bottom: number;
}>;

// 7. Types for Collision Handling and Random Bounce
type CollisionOutcome = Readonly<{
    y: number; // New bird y
    vy: number; // New bird vy
    seed: number; // Advanced RNG seed
    collided: boolean; // To check if any collision happened
}>;

/* -- 12. Ghost Replay Data Types -- */
type Trace = ReadonlyArray<Vec>; // The path of the bird during a single run
type GhostList = ReadonlyArray<Trace>; // The collection of all past paths

// 2. State processing
// -> The main immutable game state, updated each tick
type State = Readonly<{
    timeMs: number; // Elapsed game time in ms
    gameEnd: boolean; // Whether the game has ended
    bird: Bird; // Current bird status
    pipes: readonly Pipe[]; // Active pipes on screen
    lives: number; // Remaining lives (start with 3)
    score: number; // Current player score
    nextId: number; // 6. Unique ID counter for spawns
    seed: number; // 7. PRNG seed
    totalPipesPlanned: number; // 10. Total number of pipes in CSV
    ghosts: GhostList; // 12. List of traces from all past runs
    trace: Trace; // 12. Record of the current run
}>;

/** ==================== Global Store ==================== */

// 12. Stream that stores all ghost traces across game sessions
const ghostStore$ = new BehaviorSubject<GhostList>([]);

/** ==================== Helper Functions ==================== */

/* -- 7. Pure RNG Helper Function -- */
abstract class RNG {
    private static m = 0x80000000; // 2^31, modulus
    private static a = 1103515245; // multiplier
    private static c = 12345; // increment

    // Compute next hash value from given seed
    static hash = (seed: number) => (RNG.a * seed + RNG.c) % RNG.m;

    // Scale hash to the range [-1, 1]
    static scale = (hash: number) => (2 * hash) / (RNG.m - 1) - 1;
}

// Return random number in [0,1] and updated seed
const rand01 = (seed: number) => {
    const h = RNG.hash(seed);
    const r01 = (RNG.scale(h) + 1) / 2;
    return { nextSeed: h, r01 };
};

// Return random number in [lo, hi] and updated seed
const randInRange = (seed: number, lo: number, hi: number) => {
    const { nextSeed, r01 } = rand01(seed);
    return { nextSeed, value: lo + r01 * (hi - lo) };
};

/* -- 7. Collision Detection Utilities -- */
// Bird's hitbox computed from its center (x,y)
const birdHitbox = (x: number, y: number): Hitbox => ({
    left: x - bird.WIDTH / 2,
    right: x + bird.WIDTH / 2,
    top: y - bird.HEIGHT / 2,
    bottom: y + bird.HEIGHT / 2,
});

// Top pipe hitbox (from screen top to gap)
const pipeTopHitbox = (p: Pipe): Hitbox => ({
    left: p.x,
    right: p.x + Constants.PIPE_WIDTH,
    top: 0,
    bottom: p.gapY - p.gapH / 2,
});

// Bottom pipe hitbox (from gap to screen bottom)
const pipeBottomHitbox = (p: Pipe): Hitbox => ({
    left: p.x,
    right: p.x + Constants.PIPE_WIDTH,
    top: p.gapY + p.gapH / 2,
    bottom: Viewport.CANVAS_HEIGHT,
});

// Check overlap between two hitboxes (collision detection)
const overlaps = (a: Hitbox, b: Hitbox): boolean =>
    a.left < b.right &&
    a.right > b.left &&
    a.top < b.bottom &&
    a.bottom > b.top;

/** ========== State Management: Initial State and Pure Reducers ========== */

// 2. Initial game state when a game starts
const initialState: State = {
    timeMs: 0,
    gameEnd: false,
    bird: {
        pos: {
            // Bird starts around 30% from the left, vertically centered
            x: Viewport.CANVAS_WIDTH * 0.3,
            y: Viewport.CANVAS_HEIGHT / 2,
        },
        velY: 0, // No initial vertical velocity
    },
    pipes: [], // No pipes at the start
    lives: 3,
    score: 0,
    nextId: 1,
    seed: Math.floor(Math.random() * 0x7fffffff), // 7. Initialize PRNG seed
    totalPipesPlanned: 0, // 10. Will be overridden with schedule.length
    ghosts: [] as GhostList, // 12. Initialize empty list of past run traces
    trace: [] as Trace, // 12. Initialize empty trace for the current run
};

// 7. Collision Handling and Random Bounce
const handleCollisions = (s: State): CollisionOutcome => {
    const dt = Constants.TICK_RATE_MS / 1000;

    // Apply gravity and clamp velocity
    const vy = Math.max(
        -Physics.TERMINAL_VEL,
        Math.min(Physics.TERMINAL_VEL, s.bird.velY + Physics.GRAVITY * dt),
    );

    // Predict next position and clamp within screen bounds
    const yNextRaw = s.bird.pos.y + vy * dt;
    const minY = bird.HEIGHT / 2;
    const maxY = Viewport.CANVAS_HEIGHT - bird.HEIGHT / 2;
    const yClamped = Math.max(minY, Math.min(maxY, yNextRaw));

    // Build hitboxes and check collisions
    const birdRect = birdHitbox(s.bird.pos.x, yClamped);
    const hitTop = yNextRaw < minY;
    const hitBottom = yNextRaw > maxY;
    const hitPipeTop = s.pipes.some(p => overlaps(birdRect, pipeTopHitbox(p)));
    const hitPipeBottom = s.pipes.some(p =>
        overlaps(birdRect, pipeBottomHitbox(p)),
    );
    const collided = hitTop || hitBottom || hitPipeTop || hitPipeBottom;

    // Random bounce magnitude
    const bounce = (dir: 1 | -1) => {
        const r = randInRange(s.seed, Physics.BOUNCE_MIN, Physics.BOUNCE_MAX);
        return { vy: dir * Math.abs(r.value), seed: r.nextSeed };
    };

    // Apply bounce depending on where it hit
    if (hitTop) {
        const b = bounce(+1);
        return { y: minY, vy: b.vy, seed: b.seed, collided };
    }
    if (hitBottom) {
        const b = bounce(-1);
        return { y: maxY, vy: b.vy, seed: b.seed, collided };
    }
    if (hitPipeTop) {
        const b = bounce(+1);
        return {
            y: Math.min(yClamped + 1, maxY),
            vy: b.vy,
            seed: b.seed,
            collided,
        };
    }
    if (hitPipeBottom) {
        const b = bounce(-1);
        return {
            y: Math.max(yClamped - 1, minY),
            vy: b.vy,
            seed: b.seed,
            collided,
        };
    }

    // No collision -> continue normal motion
    const stoppedVy =
        (yClamped === minY && vy < 0) || (yClamped === maxY && vy > 0) ? 0 : vy;
    return { y: yClamped, vy: stoppedVy, seed: s.seed, collided };
};

// 6. A pure function reducer that generates one pipe from one line of CSV
const spawnPipe =
    (spec: SpawnSpec) =>
    (s: State): State => {
        const p: Pipe = {
            id: s.nextId,
            x: Viewport.CANVAS_WIDTH,
            gapY: spec.gapY,
            gapH: spec.gapH,
            passed: false, // 9. Newly spawned pipes are not yet passed
        };
        return { ...s, nextId: s.nextId + 1, pipes: [...s.pipes, p] };
    };

/**
 * Updates the state by proceeding with one time step.
 *
 * @param s Current state
 * @returns Updated state
 */
// 5. Advanced one tick with gravity (position & velocity) -> Bird always falls
const tick = (s: State): State => {
    // 8. Already Ended -> No updates
    if (s.gameEnd) return s;

    // The time step per tick
    const dt = Constants.TICK_RATE_MS / 1000; // ms -> s

    /* -- 7. Collision Handling and Random Bounce --
     * Delegate collision & bounce to a pure function
     */
    const col = handleCollisions(s);
    const nextY = col.y;
    const nextVy = col.vy;
    const nextSeed = col.seed;
    // 8. Lose a life on any collision (top/bottom screen or pipe)
    const nextLives = col.collided ? Math.max(0, s.lives - 1) : s.lives;

    /* -- 6. pipes: move left & cull off-screen -- */
    // Advance each pipe's x position to the left
    const moved = s.pipes.map(p => ({
        ...p,
        x: p.x - Constants.PIPE_SPEED_PX_S * dt,
    }));
    // Cull any pipe whose right edge is past the left boundary
    const kept = moved.filter(p => p.x > -Constants.PIPE_WIDTH);

    /* -- 9. scoring: +1 when the bird has passed a pipe -- */
    // Bird's left edge (use this for "passed" check)
    const birdLeft = s.bird.pos.x - bird.WIDTH / 2;

    // Make a set of previously passed pipe ids
    const prevPassed = new Set(s.pipes.filter(p => p.passed).map(p => p.id));

    // Mark pipes as passed when their right edge is left of bird's left edge
    const updatedPipes = kept.map(p =>
        p.passed || p.x + Constants.PIPE_WIDTH < birdLeft
            ? { ...p, passed: true }
            : p,
    );

    // Count how many pipes became passed this tick
    const newlyPassedCount = updatedPipes.filter(
        p => p.passed && !prevPassed.has(p.id),
    ).length;

    // Next score
    const nextScore = s.score + newlyPassedCount;

    /* -- 10. Finish when all pipes navigated or lives run out -- */
    // true if all planned pipes (from CSV) have already been spawned
    const allPipesSpawned = s.nextId - 1 >= s.totalPipesPlanned;

    // true if no pipes remain on the screen
    const allPipesCleared = updatedPipes.length === 0;

    // Game ends if lives reach 0 or all pipes have been spawned and cleared
    const nextGameEnd = nextLives <= 0 || (allPipesSpawned && allPipesCleared);

    // 12. Extend the current run's trace with the bird's new position (x, y)
    const nextTrace: Trace = [...s.trace, { x: s.bird.pos.x, y: nextY }];

    /**
     * Return the new game state
     * - copy all properties from previous state
     * - increment the elapsed time by one tick
     * - update bird position and velocity (include random bounce if collided)
     * - move pipes left, remove off-screen ones, and mark newly passed pipes
     * - advance RNG seed so next random bounce is different
     * - decrement lives if a collision occurred
     * - end a game if lives reach 0 / all pipes have been spawned and cleared
     * - increase score when the bird successfully passes through a pipe
     * - Record the bird’s path (Appends its new position to the current trace)
     * - Preserve the list of ghost traces from past runs
     */
    return {
        ...s,
        timeMs: s.timeMs + Constants.TICK_RATE_MS,
        bird: { pos: { x: s.bird.pos.x, y: nextY }, velY: nextVy },
        pipes: updatedPipes,
        seed: nextSeed,
        lives: nextLives,
        gameEnd: nextGameEnd,
        score: nextScore,
        trace: nextTrace,
        ghosts: s.ghosts,
    };
};

// 5. Handles user input (gives the bird an upward boost)
// Needs flapR, otherwise the bird can only fall by tick
const flapR = (s: State): State => ({
    ...s,
    bird: { ...s.bird, velY: Physics.FLAP_VELOCITY },
});

/** ==================== Parsing CSV to SpawnSpec ==================== */

// 3. Parse CSV into an array of SpawnSpec objects.
const parseMapCsv = (csv: string): SpawnSpec[] =>
    csv
        .trim() // Remove leading/trailing whitespace
        .split(/\r?\n/) // Split the CSV string into lines
        .slice(1) // Skip header row (gap_y,gap_height,time)
        .map(line => {
            const [yStr, hStr, timeStr] = line.split(",");

            const y = Number(yStr); // Normalized gap center (0–1)
            const h = Number(hStr); // Normalized gap height (0–1)

            return {
                // Convert normalized gap center and height to pixels
                gapY: y * Viewport.CANVAS_HEIGHT,
                gapH: h * Viewport.CANVAS_HEIGHT,
                timeMs: Number(timeStr) * 1000,
            } as SpawnSpec;
        });

/** ==================== View (Side effects) ==================== */

/**
 * Brings an SVG element to the foreground.
 * @param elem SVG element to bring to the foreground
 */
const bringToForeground = (elem: SVGElement): void => {
    elem.parentNode?.appendChild(elem);
};

/**
 * Displays a SVG element on the canvas. Brings to foreground.
 * @param elem SVG element to display
 */
const show = (elem: SVGElement): void => {
    elem.setAttribute("visibility", "visible");
    bringToForeground(elem);
};

/**
 * Hides a SVG element on the canvas.
 * @param elem SVG element to hide
 */
const hide = (elem: SVGElement): void => {
    elem.setAttribute("visibility", "hidden");
};

/**
 * Creates an SVG element with the given properties.
 *
 * @param namespace Namespace of the SVG element
 * @param name SVGElement name
 * @param props Properties to set on the SVG element
 * @returns SVG element
 */
const createSvgElement = (
    namespace: string | null,
    name: string,
    props: Record<string, string> = {},
): SVGElement => {
    const elem = document.createElementNS(namespace, name) as SVGElement;
    Object.entries(props).forEach(([k, v]) => elem.setAttribute(k, v));
    return elem;
};

/* -- Helper functions for render() -- */

// 5. Update bird position only
const makeUpdateBird =
    (img: SVGImageElement) =>
    (b: Bird): void => {
        img.setAttribute("x", `${b.pos.x - bird.WIDTH / 2}`);
        img.setAttribute("y", `${b.pos.y - bird.HEIGHT / 2}`);
    };

// 6. Sync pipes: create/update/remove according to s.pipes
type PipeElems = { top: SVGRectElement; bottom: SVGRectElement };

const makeSyncPipes =
    (svg: SVGSVGElement, pipeElems: Map<number, PipeElems>) =>
    (pipes: readonly Pipe[]): void => {
        const seen = new Set<number>();

        pipes.forEach(p => {
            // Mark this pipe ID as "still visible" for this frame
            seen.add(p.id);
            // Get or create DOM
            const pair =
                pipeElems.get(p.id) ??
                (() => {
                    const top = createSvgElement(svg.namespaceURI, "rect", {
                        x: `${p.x}`,
                        y: "0",
                        width: `${Constants.PIPE_WIDTH}`,
                        height: `${p.gapY - p.gapH / 2}`,
                        fill: "green",
                    }) as SVGRectElement;

                    const bottom = createSvgElement(svg.namespaceURI, "rect", {
                        x: `${p.x}`,
                        y: `${p.gapY + p.gapH / 2}`,
                        width: `${Constants.PIPE_WIDTH}`,
                        height: `${
                            Viewport.CANVAS_HEIGHT - (p.gapY + p.gapH / 2)
                        }`,
                        fill: "green",
                    }) as SVGRectElement;

                    svg.appendChild(top);
                    svg.appendChild(bottom);

                    const created = { top, bottom } as PipeElems;
                    pipeElems.set(p.id, created);
                    return created;
                })();

            // Horizontal scroll only
            pair.top.setAttribute("x", `${p.x}`);
            pair.bottom.setAttribute("x", `${p.x}`);
        });

        // Remove DOM for pipes no longer in state
        pipeElems.forEach((pair, id) => {
            if (!seen.has(id)) {
                svg.removeChild(pair.top);
                svg.removeChild(pair.bottom);
                pipeElems.delete(id);
            }
        });
    };

// 12. Ghost playback for all previous runs
const makeRenderGhosts =
    (svg: SVGSVGElement, ghostImgs: SVGImageElement[]) =>
    (ghosts: GhostList, timeMs: number): void => {
        // Create missing ghost images if we need more
        const deficit = Math.max(0, ghosts.length - ghostImgs.length);
        Array.from({ length: deficit }).forEach(() => {
            const img = createSvgElement(svg.namespaceURI, "image", {
                href: "assets/bird.png",
                width: `${bird.WIDTH}`,
                height: `${bird.HEIGHT}`,
                opacity: "0.006", // Keep ghost bird a bit transparent
                "pointer-events": "none", // Make it non-interactive
                visibility: "hidden", // Initially hidden
            }) as SVGImageElement;
            svg.appendChild(img);
            ghostImgs.push(img);
        });

        // Compute the frame index once based on elapsed time
        const ghostIdx = Math.floor(timeMs / Constants.TICK_RATE_MS);

        // Replay each ghost along its trace; hide when finished
        ghosts.forEach((trace, i) => {
            const img = ghostImgs[i];
            img.setAttribute("opacity", "0.006");

            const len = trace.length;
            if (len > 0 && ghostIdx < len) {
                const g = trace[ghostIdx];
                img.setAttribute("x", `${g.x - bird.WIDTH / 2}`);
                img.setAttribute("y", `${g.y - bird.HEIGHT / 2}`);
                show(img); // Show ghost at current position
            } else {
                hide(img); // Hide ghost when replay has ended or game ended
            }
        });
    };

// 8. Updates HUD (Heads-Up Display): lives, score
const makeUpdateHud =
    (livesEl?: HTMLElement, scoreEl?: HTMLElement) =>
    (lives: number, score: number): void => {
        if (livesEl) livesEl.textContent = `${lives}`;
        if (scoreEl) scoreEl.textContent = `${score}`;
    };

// 8. Game over banner + container styling
const makeToggleGameOver =
    (banner: SVGElement, container?: HTMLElement) =>
    (isOver: boolean): void => {
        isOver ? show(banner) : hide(banner);
        if (container) container.classList.toggle("game-over", isOver);
    };

// Rendering (side effects)
const render = (): ((s: State) => void) => {
    // Canvas elements
    const gameOver = document.querySelector("#gameOver") as SVGElement;
    const container = document.querySelector("#main") as HTMLElement;

    // Text fields
    const livesText = document.querySelector("#livesText") as HTMLElement;
    const scoreText = document.querySelector("#scoreText") as HTMLElement;

    const svg = document.querySelector("#svgCanvas") as SVGSVGElement;

    svg.setAttribute(
        "viewBox",
        `0 0 ${Viewport.CANVAS_WIDTH} ${Viewport.CANVAS_HEIGHT}`,
    );

    // --- Create elements Once ---
    // Bird image
    const birdImg = createSvgElement(svg.namespaceURI, "image", {
        href: "assets/bird.png",
        x: `${Viewport.CANVAS_WIDTH * 0.3 - bird.WIDTH / 2}`,
        y: `${Viewport.CANVAS_HEIGHT / 2 - bird.HEIGHT / 2}`,
        width: `${bird.WIDTH}`,
        height: `${bird.HEIGHT}`,
    }) as SVGImageElement;
    svg.appendChild(birdImg);

    // 12. Array of ghost bird images (will grow dynamically as needed)
    const ghostImgs: SVGImageElement[] = [];

    // 6. Keep pipe DOM references in closure
    // Map: pipeId -> its SVG rect elements
    const pipeElems = new Map<number, PipeElems>();

    // Call Helper functions
    const drawBird = makeUpdateBird(birdImg); // 5
    const drawPipes = makeSyncPipes(svg, pipeElems); // 6
    const drawGhosts = makeRenderGhosts(svg, ghostImgs); // 12
    const drawHud = makeUpdateHud(livesText, scoreText); // 8
    const drawGameOver = makeToggleGameOver(gameOver, container); // 8

    /**
     * Renders the current state to the canvas.
     *
     * In MVC terms, this updates the View using the Model.
     *
     * @param s Current state
     */
    return (s: State) => {
        drawBird(s.bird);
        drawPipes(s.pipes);
        drawGhosts(s.ghosts, s.timeMs);
        drawHud(s.lives, s.score);
        drawGameOver(s.gameEnd);
    };
};

/** ==================== Create a State Observable ==================== */

export const state$ = (
    csvContents: string,
    ghosts: GhostList = [], // 12. Default to an empty list of past run traces
): Observable<State> => {
    /** User input */
    // 3. Parse CSV into spawn schedule
    const schedule: readonly SpawnSpec[] = parseMapCsv(csvContents);

    const key$ = fromEvent<KeyboardEvent>(document, "keypress");
    const fromKey = (keyCode: Key) =>
        key$.pipe(filter(({ code }) => code === keyCode));

    /** Determines the rate of time steps */
    const tick$ = interval(Constants.TICK_RATE_MS);

    /* -- 4. Core minimal changes -- */
    // tick$ emits a reducer (State -> State)
    const tickReducers$ = tick$.pipe(map(() => tick));

    // Space key emits a reducer (State -> State)
    const flapReducers$ = fromKey("Space").pipe(map(() => flapR));

    // 6. Spawn reducers from CSV schedule
    const spawnReducers$ = merge(
        ...schedule.map(spec =>
            timer(spec.timeMs).pipe(map(() => spawnPipe(spec))),
        ),
    );

    // Merge reducer streams and appply them to state with scan
    return merge(tickReducers$, flapReducers$, spawnReducers$).pipe(
        scan((s, reducer) => reducer(s), {
            ...initialState,
            seed: Math.floor(Math.random() * 0x7fffffff), // 11. Initialization
            totalPipesPlanned: schedule.length, // 10. Inject plan size here
            ghosts, // 12. Inject the list of past run traces
            trace: [] as Trace, // 12. Start with an empty trace
        }),
    );
};

/** ==================== Execute application ==================== */

// The following simply runs your main function on window load.
// Make sure to leave it in place.
// You should not need to change this, beware if you are.
if (typeof window !== "undefined") {
    const { protocol, hostname, port } = new URL(import.meta.url);
    const baseUrl = `${protocol}//${hostname}${port ? `:${port}` : ""}`;
    const csvUrl = `${baseUrl}/assets/map.csv`;

    // Get the file from URL
    const csv$ = fromFetch(csvUrl).pipe(
        switchMap(response => {
            if (response.ok) {
                return response.text();
            } else {
                throw new Error(`Fetch error: ${response.status}`);
            }
        }),
        catchError(err => {
            console.error("Error fetching the CSV file:", err);
            throw err;
        }),
    );

    // Observable: wait for first user click
    const click$ = fromEvent(document.body, "mousedown").pipe(take(1));

    // 11. Restart on "R Key"
    const restart$ = fromEvent<KeyboardEvent>(document, "keypress").pipe(
        filter(e => e.code === "KeyR"),
    );

    csv$.pipe(
        switchMap(contents =>
            // 11. Click the first time, then R Key to switch to restart
            merge(click$, restart$).pipe(
                // 12. Stream GhostList together with user events
                withLatestFrom(ghostStore$),
                switchMap(
                    (
                        [, ghosts], // 12. ghosts: GhostList from store
                    ) =>
                        state$(contents, ghosts).pipe(
                            tap(s => {
                                if (s.gameEnd) {
                                    // 12. Get current GhostList from store
                                    const prev: GhostList =
                                        ghostStore$.getValue();
                                    const nextGhosts: GhostList = [
                                        ...prev,
                                        s.trace,
                                    ]; // 12. Append the current run's trace
                                    // 12. Update store with new GhostList
                                    ghostStore$.next(nextGhosts);
                                }
                            }),
                        ),
                ),
            ),
        ),
    ).subscribe(render()); // Render game state continuously
}
