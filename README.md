# Flappy Bird (RxJS + TypeScript)

A small Flappy Bird–style browser game built with TypeScript and RxJS. The project demonstrates functional reactive programming (FRP) concepts such as immutable state, pure reducers, and event streams.

## Features

- Bird physics & collisions (gravity, velocity clamping, hit detection)  
- Score tracking as pure state transitions  
- Restart functionality via hotkeys  
- Ghost birds (previous runs replayed alongside current gameplay)  
- Deterministic randomness for reproducible runs  

## Usage

Setup (requires node.js):

```bash
> npm install
```

Start tests:

```bash
> npm test
```

Serve up the App (and ctrl-click the URL that appears in the console)

```bash
> npm run dev
```

To generate a map:

```bash
npm run generate-pipes
```

## Tech Stack
- TypeScript, RxJS, Vite, Vitest, Prettier


