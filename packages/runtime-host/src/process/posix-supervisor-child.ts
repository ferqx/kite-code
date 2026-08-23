import { runPosixSupervisorChild } from './posix-supervisor-child-runtime';

runPosixSupervisorChild(process.argv.slice(2));
