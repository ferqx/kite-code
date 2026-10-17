import { runWindowsNativeVerifierMain } from './windows-native-verifier';

// Executable-only wrapper; imported verifier libraries keep their side-effect-free entry guard.
await runWindowsNativeVerifierMain();
