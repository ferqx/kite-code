import { expect, test } from 'bun:test';
import {
  analyzeVmObserverTrace,
  decodeVmObserverTrace,
  type VmTrace,
} from '../../../scripts/runtime/unified-soak-vm-observer';

// Captured actual Bun1.4.2 Darwin calibration; decoder checks run unconditionally on every OS.
// This retained wire sample does not execute native instrumentation or qualify another platform.
const calibrationRaw =
  '{"kind":"begin","version":1,"pid":30487,"birthSeconds":"1791797805","birthMicroseconds":"847263","birthBytes":136,"birthExpected":136,"timeNumer":125,"timeDenom":3,"timeError":0,"scope":"after-constructor POSIX VM imports, not live blocks or whole VM"}\n{"kind":"mmap","pid":30487,"thread":"1093847","threadError":0,"startedTicks":"798555588502","completedTicks":"798555588561","protection":0,"flags":4162,"offset":"0","address":"0x108a68000","length":"4456448","arg":-268435456,"result":0,"errno":0,"frames":[{"pc":"0x104014a68","base":"0x104014000","symbolAddress":"0x104014984","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"trace"},{"pc":"0x104014f70","base":"0x104014000","symbolAddress":"0x104014edc","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"observe_mmap"},{"pc":"0x10034bd68","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034b9c0","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034b584","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034b19c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100348f58","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100348d54","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x18f78ea28","base":"0x18f740000","symbolAddress":"0x18f78e974","image":"/usr/lib/dyld","symbol":"___ZZNK5dyld46Loader25findAndRunAllInitializersERNS_12RuntimeStateEENK3$_0clEv_block_invoke"},{"pc":"0x18f799a8c","base":"0x18f740000","symbolAddress":"0x18f79994c","image":"/usr/lib/dyld","symbol":"___ZNK5dyld313MachOAnalyzer18forEachInitializerER11DiagnosticsRKNS0_15VMAddrConverterEU13block_pointerFvjEPKv_block_invoke.204"},{"pc":"0x18f7d9fac","base":"0x18f740000","symbolAddress":"0x18f7d9e74","image":"/usr/lib/dyld","symbol":"___ZNK6mach_o12UnsafeHeader14forEachSectionEU13block_pointerFvRKNS0_11SectionInfoERbE_block_invoke"},{"pc":"0x18f7d69a4","base":"0x18f740000","symbolAddress":"0x18f7d68d4","image":"/usr/lib/dyld","symbol":"_ZNK6mach_o12UnsafeHeader18forEachLoadCommandEU13block_pointerFvPK12load_commandRbE"},{"pc":"0x18f7d824c","base":"0x18f740000","symbolAddress":"0x18f7d81d0","image":"/usr/lib/dyld","symbol":"_ZNK6mach_o12UnsafeHeader14forEachSectionEU13block_pointerFvRKNS0_11SectionInfoERbE"},{"pc":"0x18f799580","base":"0x18f740000","symbolAddress":"0x18f79937c","image":"/usr/lib/dyld","symbol":"_ZNK5dyld313MachOAnalyzer18forEachInitializerER11DiagnosticsRKNS0_15VMAddrConverterEU13block_pointerFvjEPKv"},{"pc":"0x18f789394","base":"0x18f740000","symbolAddress":"0x18f789184","image":"/usr/lib/dyld","symbol":"_ZNK5dyld46Loader25findAndRunAllInitializersERNS_12RuntimeStateE"},{"pc":"0x18f781cd0","base":"0x18f740000","symbolAddress":"0x18f781cac","image":"/usr/lib/dyld","symbol":"_ZNK5dyld416JustInTimeLoader15runInitializersERNS_12RuntimeStateE"},{"pc":"0x18f789ab0","base":"0x18f740000","symbolAddress":"0x18f789878","image":"/usr/lib/dyld","symbol":"_ZNK5dyld46Loader23runInitializersBottomUpERNS_12RuntimeStateERN3lsl6VectorI18AuthenticatedValueIPKS0_EEESA_"},{"pc":"0x18f78eac0","base":"0x18f740000","symbolAddress":"0x18f78ea4c","image":"/usr/lib/dyld","symbol":"_ZZNK5dyld46Loader38runInitializersBottomUpPlusUpwardLinksERNS_12RuntimeStateEENK3$_0clEv"},{"pc":"0x18f789d98","base":"0x18f740000","symbolAddress":"0x18f789acc","image":"/usr/lib/dyld","symbol":"_ZNK5dyld46Loader38runInitializersBottomUpPlusUpwardLinksERNS_12RuntimeStateE"},{"pc":"0x18f761ba4","base":"0x18f740000","symbolAddress":"0x18f760b4c","image":"/usr/lib/dyld","symbol":"_ZN5dyld4L7prepareERNS_4APIsEPKN6mach_o12UnsafeHeaderE"},{"pc":"0x18f760b30","base":"0x18f740000","symbolAddress":"0x18f7609f0","image":"/usr/lib/dyld","symbol":"_ZZN5dyld45startEPNS_10KernelArgsEPvS2_yENK3$_1clEv"},{"pc":"0x18f76048c","base":"0x18f740000","symbolAddress":"0x18f75e994","image":"/usr/lib/dyld","symbol":"start"}],"sequence":"0","frameLimit":24}\n{"kind":"mmap","pid":30487,"thread":"1093847","threadError":0,"startedTicks":"798555596465","completedTicks":"798555596565","protection":3,"flags":4162,"offset":"0","address":"0x31142000000","length":"1073741824","arg":-268435456,"result":0,"errno":0,"frames":[{"pc":"0x104014a68","base":"0x104014000","symbolAddress":"0x104014984","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"trace"},{"pc":"0x104014f70","base":"0x104014000","symbolAddress":"0x104014edc","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"observe_mmap"},{"pc":"0x10034bcfc","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034b9c0","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034b584","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034f9a0","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034f7d0","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034f328","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034ec84","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034eaec","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034e598","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034dff4","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034df0c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034db0c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034d4d4","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034c68c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x18f7604e4","base":"0x18f740000","symbolAddress":"0x18f75e994","image":"/usr/lib/dyld","symbol":"start"}],"sequence":"1","frameLimit":24}\n{"kind":"mmap","pid":30487,"thread":"1093847","threadError":0,"startedTicks":"798555597751","completedTicks":"798555597781","protection":3,"flags":4162,"offset":"0","address":"0x104024000","length":"65536","arg":-268435456,"result":0,"errno":0,"frames":[{"pc":"0x104014a68","base":"0x104014000","symbolAddress":"0x104014984","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"trace"},{"pc":"0x104014f70","base":"0x104014000","symbolAddress":"0x104014edc","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"observe_mmap"},{"pc":"0x10034bd68","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034b9c0","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100351d98","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100351b7c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034f0cc","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034eaec","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034e598","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034dff4","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034df0c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034db0c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034d4d4","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034c68c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x18f7604e4","base":"0x18f740000","symbolAddress":"0x18f75e994","image":"/usr/lib/dyld","symbol":"start"}],"sequence":"2","frameLimit":24}\n{"kind":"mmap","pid":30487,"thread":"1093847","threadError":0,"startedTicks":"798555609427","completedTicks":"798555609486","protection":7,"flags":6146,"offset":"0","address":"0x120e04000","length":"536903680","arg":1073741824,"result":0,"errno":0,"frames":[{"pc":"0x104014a68","base":"0x104014000","symbolAddress":"0x104014984","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"trace"},{"pc":"0x104014f70","base":"0x104014000","symbolAddress":"0x104014edc","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"observe_mmap"},{"pc":"0x100382ef8","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10038287c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100382688","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x18fa3d3b8","base":"0x18fa3b000","symbolAddress":"0x18fa3d2f4","image":"/usr/lib/libc++.1.dylib","symbol":"_ZNSt3__111__call_onceERVmPvPFvS2_E"},{"pc":"0x100370a90","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x18fa3d3b8","base":"0x18fa3b000","symbolAddress":"0x18fa3d2f4","image":"/usr/lib/libc++.1.dylib","symbol":"_ZNSt3__111__call_onceERVmPvPFvS2_E"},{"pc":"0x10036fc40","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x18fa3d3b8","base":"0x18fa3b000","symbolAddress":"0x18fa3d2f4","image":"/usr/lib/libc++.1.dylib","symbol":"_ZNSt3__111__call_onceERVmPvPFvS2_E"},{"pc":"0x10036fb0c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10036f01c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1005b5edc","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100356a78","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100352e88","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034d4f0","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034c68c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x18f7604e4","base":"0x18f740000","symbolAddress":"0x18f75e994","image":"/usr/lib/dyld","symbol":"start"}],"sequence":"3","frameLimit":24}\n{"kind":"mmap","pid":30487,"thread":"1093847","threadError":0,"startedTicks":"798555610682","completedTicks":"798555610743","protection":0,"flags":4114,"offset":"0","address":"0x120e04000","length":"16384","arg":1073741824,"result":0,"errno":0,"frames":[{"pc":"0x104014a68","base":"0x104014000","symbolAddress":"0x104014984","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"trace"},{"pc":"0x104014f70","base":"0x104014000","symbolAddress":"0x104014edc","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"observe_mmap"},{"pc":"0x100382f2c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10038287c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100382688","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x18fa3d3b8","base":"0x18fa3b000","symbolAddress":"0x18fa3d2f4","image":"/usr/lib/libc++.1.dylib","symbol":"_ZNSt3__111__call_onceERVmPvPFvS2_E"},{"pc":"0x100370a90","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x18fa3d3b8","base":"0x18fa3b000","symbolAddress":"0x18fa3d2f4","image":"/usr/lib/libc++.1.dylib","symbol":"_ZNSt3__111__call_onceERVmPvPFvS2_E"},{"pc":"0x10036fc40","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x18fa3d3b8","base":"0x18fa3b000","symbolAddress":"0x18fa3d2f4","image":"/usr/lib/libc++.1.dylib","symbol":"_ZNSt3__111__call_onceERVmPvPFvS2_E"},{"pc":"0x10036fb0c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10036f01c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1005b5edc","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100356a78","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100352e88","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034d4f0","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034c68c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x18f7604e4","base":"0x18f740000","symbolAddress":"0x18f75e994","image":"/usr/lib/dyld","symbol":"start"}],"sequence":"4","frameLimit":24}\n{"kind":"mmap","pid":30487,"thread":"1093847","threadError":0,"startedTicks":"798555611817","completedTicks":"798555611868","protection":0,"flags":4114,"offset":"0","address":"0x140e08000","length":"16384","arg":1073741824,"result":0,"errno":0,"frames":[{"pc":"0x104014a68","base":"0x104014000","symbolAddress":"0x104014984","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"trace"},{"pc":"0x104014f70","base":"0x104014000","symbolAddress":"0x104014edc","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"observe_mmap"},{"pc":"0x100382f4c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10038287c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100382688","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x18fa3d3b8","base":"0x18fa3b000","symbolAddress":"0x18fa3d2f4","image":"/usr/lib/libc++.1.dylib","symbol":"_ZNSt3__111__call_onceERVmPvPFvS2_E"},{"pc":"0x100370a90","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x18fa3d3b8","base":"0x18fa3b000","symbolAddress":"0x18fa3d2f4","image":"/usr/lib/libc++.1.dylib","symbol":"_ZNSt3__111__call_onceERVmPvPFvS2_E"},{"pc":"0x10036fc40","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x18fa3d3b8","base":"0x18fa3b000","symbolAddress":"0x18fa3d2f4","image":"/usr/lib/libc++.1.dylib","symbol":"_ZNSt3__111__call_onceERVmPvPFvS2_E"},{"pc":"0x10036fb0c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10036f01c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1005b5edc","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100356a78","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100352e88","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034d4f0","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034c68c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x18f7604e4","base":"0x18f740000","symbolAddress":"0x18f75e994","image":"/usr/lib/dyld","symbol":"start"}],"sequence":"5","frameLimit":24}\n{"kind":"madvise","pid":30487,"thread":"1093847","threadError":0,"startedTicks":"798555612809","completedTicks":"798555615546","protection":0,"flags":0,"offset":"0","address":"0x120e08000","length":"536870912","arg":7,"result":0,"errno":0,"frames":[{"pc":"0x104014a68","base":"0x104014000","symbolAddress":"0x104014984","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"trace"},{"pc":"0x1040150a4","base":"0x104014000","symbolAddress":"0x10401502c","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"observe_madvise"},{"pc":"0x100382894","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100382688","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x18fa3d3b8","base":"0x18fa3b000","symbolAddress":"0x18fa3d2f4","image":"/usr/lib/libc++.1.dylib","symbol":"_ZNSt3__111__call_onceERVmPvPFvS2_E"},{"pc":"0x100370a90","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x18fa3d3b8","base":"0x18fa3b000","symbolAddress":"0x18fa3d2f4","image":"/usr/lib/libc++.1.dylib","symbol":"_ZNSt3__111__call_onceERVmPvPFvS2_E"},{"pc":"0x10036fc40","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x18fa3d3b8","base":"0x18fa3b000","symbolAddress":"0x18fa3d2f4","image":"/usr/lib/libc++.1.dylib","symbol":"_ZNSt3__111__call_onceERVmPvPFvS2_E"},{"pc":"0x10036fb0c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10036f01c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1005b5edc","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100356a78","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100352e88","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034d4f0","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034c68c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x18f7604e4","base":"0x18f740000","symbolAddress":"0x18f75e994","image":"/usr/lib/dyld","symbol":"start"}],"sequence":"6","frameLimit":24}\n{"kind":"madvise","pid":30487,"thread":"1093847","threadError":0,"startedTicks":"798555616978","completedTicks":"798555617016","protection":0,"flags":0,"offset":"0","address":"0x300000000","length":"4294967296","arg":7,"result":0,"errno":0,"frames":[{"pc":"0x104014a68","base":"0x104014000","symbolAddress":"0x104014984","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"trace"},{"pc":"0x1040150a4","base":"0x104014000","symbolAddress":"0x10401502c","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"observe_madvise"},{"pc":"0x10038420c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100370ac8","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x18fa3d3b8","base":"0x18fa3b000","symbolAddress":"0x18fa3d2f4","image":"/usr/lib/libc++.1.dylib","symbol":"_ZNSt3__111__call_onceERVmPvPFvS2_E"},{"pc":"0x10036fc40","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x18fa3d3b8","base":"0x18fa3b000","symbolAddress":"0x18fa3d2f4","image":"/usr/lib/libc++.1.dylib","symbol":"_ZNSt3__111__call_onceERVmPvPFvS2_E"},{"pc":"0x10036fb0c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10036f01c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1005b5edc","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100356a78","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100352e88","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034d4f0","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034c68c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x18f7604e4","base":"0x18f740000","symbolAddress":"0x18f75e994","image":"/usr/lib/dyld","symbol":"start"}],"sequence":"7","frameLimit":24}\n{"kind":"madvise","pid":30487,"thread":"1093847","threadError":0,"startedTicks":"798555619118","completedTicks":"798555619146","protection":0,"flags":0,"offset":"0","address":"0x120e08000","length":"16384","arg":8,"result":0,"errno":0,"frames":[{"pc":"0x104014a68","base":"0x104014000","symbolAddress":"0x104014984","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"trace"},{"pc":"0x1040150a4","base":"0x104014000","symbolAddress":"0x10401502c","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"observe_madvise"},{"pc":"0x1003924b0","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1003915b8","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1003913cc","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10038f374","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10038e530","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x18fa3d3b8","base":"0x18fa3b000","symbolAddress":"0x18fa3d2f4","image":"/usr/lib/libc++.1.dylib","symbol":"_ZNSt3__111__call_onceERVmPvPFvS2_E"},{"pc":"0x100384dd4","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100370aec","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x18fa3d3b8","base":"0x18fa3b000","symbolAddress":"0x18fa3d2f4","image":"/usr/lib/libc++.1.dylib","symbol":"_ZNSt3__111__call_onceERVmPvPFvS2_E"},{"pc":"0x10036fc40","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x18fa3d3b8","base":"0x18fa3b000","symbolAddress":"0x18fa3d2f4","image":"/usr/lib/libc++.1.dylib","symbol":"_ZNSt3__111__call_onceERVmPvPFvS2_E"},{"pc":"0x10036fb0c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10036f01c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1005b5edc","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100356a78","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100352e88","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034d4f0","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034c68c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x18f7604e4","base":"0x18f740000","symbolAddress":"0x18f75e994","image":"/usr/lib/dyld","symbol":"start"}],"sequence":"8","frameLimit":24}\n{"kind":"mmap","pid":30487,"thread":"1093847","threadError":0,"startedTicks":"798555626889","completedTicks":"798555626964","protection":3,"flags":4098,"offset":"0","address":"0x108ea8000","length":"4194304","arg":-1,"result":0,"errno":0,"frames":[{"pc":"0x104014a68","base":"0x104014000","symbolAddress":"0x104014984","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"trace"},{"pc":"0x104014f70","base":"0x104014000","symbolAddress":"0x104014edc","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"observe_mmap"},{"pc":"0x10039cde0","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10039cd78","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10039bc48","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100399c1c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1003975cc","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10036f1f4","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1005b5edc","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100356a78","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100352e88","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034d4f0","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034c68c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x18f7604e4","base":"0x18f740000","symbolAddress":"0x18f75e994","image":"/usr/lib/dyld","symbol":"start"}],"sequence":"9","frameLimit":24}\n{"kind":"mmap","pid":30487,"thread":"1093847","threadError":0,"startedTicks":"798555653733","completedTicks":"798555653848","protection":1,"flags":1,"offset":"0","address":"0x103cbc000","length":"16384","arg":5,"result":0,"errno":0,"frames":[{"pc":"0x104014a68","base":"0x104014000","symbolAddress":"0x104014984","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"trace"},{"pc":"0x104014f70","base":"0x104014000","symbolAddress":"0x104014edc","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"observe_mmap"},{"pc":"0x193f8092c","base":"0x193f76000","symbolAddress":"0x193f7cd78","image":"/usr/lib/system/libsystem_notify.dylib","symbol":"_notify_fork_child"},{"pc":"0x193f770f8","base":"0x193f76000","symbolAddress":"0x193f76b38","image":"/usr/lib/system/libsystem_notify.dylib","symbol":"notify_register_check"},{"pc":"0x18f9c19c8","base":"0x18f9b9000","symbolAddress":"0x18f9c18dc","image":"/usr/lib/system/libsystem_c.dylib","symbol":"notify_register_tz"},{"pc":"0x18f9dea74","base":"0x18f9b9000","symbolAddress":"0x18f9dea08","image":"/usr/lib/system/libsystem_c.dylib","symbol":"gmt_init"},{"pc":"0x18fb27bb4","base":"0x18fb25000","symbolAddress":"0x18fb27b6c","image":"/usr/lib/system/libsystem_pthread.dylib","symbol":"__pthread_once_handler"},{"pc":"0x18fb32b98","base":"0x18fb32000","symbolAddress":"0x18fb32b78","image":"/usr/lib/system/libsystem_platform.dylib","symbol":"_os_once_callout"},{"pc":"0x18fb32b6c","base":"0x18fb32000","symbolAddress":"0x18fb32b20","image":"/usr/lib/system/libsystem_platform.dylib","symbol":"_os_once"},{"pc":"0x18fb27b50","base":"0x18fb25000","symbolAddress":"0x18fb27aec","image":"/usr/lib/system/libsystem_pthread.dylib","symbol":"pthread_once"},{"pc":"0x18f9de9ac","base":"0x18f9b9000","symbolAddress":"0x18f9de964","image":"/usr/lib/system/libsystem_c.dylib","symbol":"gmtsub"},{"pc":"0x1003bd1e0","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1003bc6cc","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10039761c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10036f1f4","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1005b5edc","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100356a78","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100352e88","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034d4f0","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034c68c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x18f7604e4","base":"0x18f740000","symbolAddress":"0x18f75e994","image":"/usr/lib/dyld","symbol":"start"}],"sequence":"10","frameLimit":24}\n{"kind":"mmap","pid":30487,"thread":"1093847","threadError":0,"startedTicks":"798555658476","completedTicks":"798555658514","protection":3,"flags":4162,"offset":"0","address":"0x104034000","length":"65536","arg":-268435456,"result":0,"errno":0,"frames":[{"pc":"0x104014a68","base":"0x104014000","symbolAddress":"0x104014984","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"trace"},{"pc":"0x104014f70","base":"0x104014000","symbolAddress":"0x104014edc","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"observe_mmap"},{"pc":"0x10034bd68","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034b9c0","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100351d98","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100351b7c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034f0cc","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034ead0","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034e5c0","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034dff4","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100363024","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100352614","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1003d0840","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1003cecd8","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1003c2e00","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1003be868","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1003bda24","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100397634","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10036f1f4","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1005b5edc","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100356a78","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100352e88","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034d4f0","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10034c68c","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null}],"sequence":"11","frameLimit":24}\n{"kind":"mmap","pid":30487,"thread":"1093847","threadError":0,"startedTicks":"798555775740","completedTicks":"798555775805","protection":3,"flags":4098,"offset":"0","address":"0x1040b4000","length":"65536","arg":-1,"result":0,"errno":0,"frames":[{"pc":"0x104014a68","base":"0x104014000","symbolAddress":"0x104014984","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"trace"},{"pc":"0x104014f70","base":"0x104014000","symbolAddress":"0x104014edc","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"observe_mmap"},{"pc":"0x1040a4494","base":"0x1040a4000","symbolAddress":"0x1040a4470","image":"/private/tmp/kite-rss-vm-calibration.dylib","symbol":"kite_map"},{"pc":"0x120e0b018","base":"0x0","symbolAddress":"0x0","image":null,"symbol":null},{"pc":"0x120e0b090","base":"0x0","symbolAddress":"0x0","image":null,"symbol":null},{"pc":"0x1035537b8","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1035302b4","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100590378","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100590048","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058fc20","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058f944","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058f614","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058ea24","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058e4b4","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058dd08","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058daa8","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004c5820","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004c2970","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100442244","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004c1808","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004c0b50","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004c0824","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004a4fd8","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004a41fc","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null}],"sequence":"12","frameLimit":24}\n{"kind":"madvise","pid":30487,"thread":"1093847","threadError":0,"startedTicks":"798555777928","completedTicks":"798555778031","protection":0,"flags":0,"offset":"0","address":"0x1040b4000","length":"65536","arg":7,"result":0,"errno":0,"frames":[{"pc":"0x104014a68","base":"0x104014000","symbolAddress":"0x104014984","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"trace"},{"pc":"0x1040150a4","base":"0x104014000","symbolAddress":"0x10401502c","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"observe_madvise"},{"pc":"0x120e0b1d8","base":"0x0","symbolAddress":"0x0","image":null,"symbol":null},{"pc":"0x120e0b250","base":"0x0","symbolAddress":"0x0","image":null,"symbol":null},{"pc":"0x1035537b8","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1035302b4","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100590378","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100590048","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058fc20","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058f944","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058f614","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058ea24","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058e4b4","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058dd08","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058daa8","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004c5820","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004c2970","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100442244","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004c1808","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004c0b50","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004c0824","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004a4fd8","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004a41fc","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10036f664","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null}],"sequence":"13","frameLimit":24}\n{"kind":"munmap","pid":30487,"thread":"1093847","threadError":0,"startedTicks":"798555779438","completedTicks":"798555779525","protection":0,"flags":0,"offset":"0","address":"0x1040b4000","length":"32768","arg":0,"result":0,"errno":0,"frames":[{"pc":"0x104014a68","base":"0x104014000","symbolAddress":"0x104014984","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"trace"},{"pc":"0x104015008","base":"0x104014000","symbolAddress":"0x104014f98","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"observe_munmap"},{"pc":"0x120e0b1d8","base":"0x0","symbolAddress":"0x0","image":null,"symbol":null},{"pc":"0x120e0b390","base":"0x0","symbolAddress":"0x0","image":null,"symbol":null},{"pc":"0x1035537b8","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1035302b4","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100590378","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100590048","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058fc20","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058f944","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058f614","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058ea24","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058e4b4","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058dd08","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058daa8","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004c5820","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004c2970","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100442244","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004c1808","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004c0b50","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004c0824","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004a4fd8","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004a41fc","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10036f664","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null}],"sequence":"14","frameLimit":24}\n{"kind":"munmap","pid":30487,"thread":"1093847","threadError":0,"startedTicks":"798555780456","completedTicks":"798555780543","protection":0,"flags":0,"offset":"0","address":"0x1040bc000","length":"32768","arg":0,"result":0,"errno":0,"frames":[{"pc":"0x104014a68","base":"0x104014000","symbolAddress":"0x104014984","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"trace"},{"pc":"0x104015008","base":"0x104014000","symbolAddress":"0x104014f98","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"observe_munmap"},{"pc":"0x120e0b1d8","base":"0x0","symbolAddress":"0x0","image":null,"symbol":null},{"pc":"0x120e0b4d0","base":"0x0","symbolAddress":"0x0","image":null,"symbol":null},{"pc":"0x1035537b8","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1035302b4","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100590378","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100590048","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058fc20","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058f944","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058f614","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058ea24","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058e4b4","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058dd08","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058daa8","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004c5820","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004c2970","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100442244","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004c1808","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004c0b50","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004c0824","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004a4fd8","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004a41fc","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10036f664","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null}],"sequence":"15","frameLimit":24}\n{"kind":"mmap","pid":30487,"thread":"1093847","threadError":0,"startedTicks":"798555781275","completedTicks":"798555781276","protection":0,"flags":4098,"offset":"0","address":"0xffffffffffffffff","length":"0","arg":-1,"result":-1,"errno":22,"frames":[{"pc":"0x104014a68","base":"0x104014000","symbolAddress":"0x104014984","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"trace"},{"pc":"0x104014f70","base":"0x104014000","symbolAddress":"0x104014edc","image":"/private/tmp/kite-rss-vm-interpose-owned.dylib","symbol":"observe_mmap"},{"pc":"0x1040a452c","base":"0x1040a4000","symbolAddress":"0x1040a44f8","image":"/private/tmp/kite-rss-vm-calibration.dylib","symbol":"kite_error"},{"pc":"0x120e0b1d8","base":"0x0","symbolAddress":"0x0","image":null,"symbol":null},{"pc":"0x120e0b610","base":"0x0","symbolAddress":"0x0","image":null,"symbol":null},{"pc":"0x1035537b8","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1035302b4","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100590378","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100590048","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058fc20","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058f944","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058f614","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058ea24","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058e4b4","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058dd08","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x10058daa8","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004c5820","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004c2970","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x100442244","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004c1808","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004c0b50","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004c0824","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004a4fd8","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null},{"pc":"0x1004a41fc","base":"0x100348000","symbolAddress":"0x0","image":"/Users/chenchao/.nvm/versions/node/v22.21.1/lib/node_modules/bun/bin/bun.exe","symbol":null}],"sequence":"16","frameLimit":24}\n{"kind":"finish","pid":30487,"events":"17","writeErrors":"0","nestedCalls":"0"}\n';
const calibrationStdout = '{"pid":30487,"address":"4362813440","normal":true}\n';
const bytes = (text: string) => new TextEncoder().encode(text);
const rows = () =>
  calibrationRaw
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
const wire = (records: unknown[]) =>
  bytes(`${records.map((row) => JSON.stringify(row)).join('\n')}\n`);
const altered = (edit: (records: ReturnType<typeof rows>) => void) => {
  const records = rows();
  edit(records);
  return wire(records);
};

test('actual calibrated mmap advice and two partial unmaps retain exact syscall identity and intervals', () => {
  const trace = decodeVmObserverTrace(bytes(calibrationRaw));
  const stdout = JSON.parse(calibrationStdout);
  expect(trace.begin.pid).toBe(stdout.pid);
  expect(trace.events).toHaveLength(17);
  expect(trace.finish).toEqual({
    kind: 'finish',
    pid: stdout.pid,
    events: '17',
    writeErrors: '0',
    nestedCalls: '0',
  });
  const known = trace.events.find(
    (event) =>
      event.kind === 'mmap' && event.address === `0x${BigInt(stdout.address).toString(16)}`,
  )!;
  expect(known.length).toBe('65536');
  const summary = analyzeVmObserverTrace(trace);
  expect(summary.timeScale).toEqual({ numer: 125, denom: 3 });
  const map = summary.mappingIntersections.find((event) => event.sequence === known.sequence)!;
  expect(map.intersections.map((event) => [event.address, event.length])).toEqual([
    [known.address, '32768'],
    [`0x${(BigInt(known.address) + 32768n).toString(16)}`, '32768'],
  ]);
  expect(map.coveredBytes).toBe('65536');
  expect(map.coverage).toBe('full_observed_intersection');
  expect(
    summary.events.find((event) => event.kind === 'madvise' && event.address === known.address)
      ?.arg,
  ).toBe(7);
  expect(summary.events.find((event) => event.result === -1)).toMatchObject({
    kind: 'mmap',
    address: '0xffffffffffffffff',
    length: '0',
    errno: 22,
  });
  expect(
    summary.callsites.some(
      (site) => site.image?.endsWith('kite-rss-vm-calibration.dylib') && site.pcRelative !== null,
    ),
  ).toBe(true);
  expect(summary.mappingIntersections.some((map) => map.tagCategory === 'tag_240')).toBe(true);
  expect(summary).toMatchObject({
    completeProcess: false,
    completeResources: false,
    formalQualified: false,
    liveAllocations: null,
    businessOwner: null,
  });
});

function intervalTrace(pairs: number, sameAddress = false): VmTrace {
  const trace = decodeVmObserverTrace(bytes(calibrationRaw));
  const template = trace.events.find((event) => event.kind === 'mmap' && event.result === 0)!;
  const events: VmTrace['events'] = [];
  for (let index = 0; index < pairs; index++) {
    const address = `0x${(0x20000000000001n + (sameAddress ? 0n : BigInt(pairs - index) * 8192n)).toString(16)}`;
    const ticks = 100n + BigInt(index) * 4n;
    for (const [offset, kind] of ['mmap', 'munmap'].entries()) {
      events.push({
        ...template,
        kind: kind as 'mmap' | 'munmap',
        thread: '1',
        address,
        length: '4096',
        startedTicks: String(ticks + BigInt(offset) * 2n),
        completedTicks: String(ticks + BigInt(offset) * 2n + 1n),
        sequence: String(events.length),
      });
    }
  }
  return { ...trace, events, finish: { ...trace.finish, events: String(events.length) } };
}

test('sparse disjoint mappings retain every exact intersection within the unchanged default work budget', () => {
  const trace = intervalTrace(4096);
  const summary = analyzeVmObserverTrace(trace);
  expect(summary.mappingIntersections).toHaveLength(4096);
  for (const [index, map] of summary.mappingIntersections.entries()) {
    const unmap = trace.events[index * 2 + 1]!;
    expect(map.sequence).toBe(String(index * 2));
    expect(map.intersections).toEqual([
      {
        sequence: unmap.sequence,
        address: unmap.address,
        length: '4096',
        start: unmap.address,
        end: `0x${(BigInt(unmap.address) + 4096n).toString(16)}`,
        startedTicks: unmap.startedTicks,
        completedTicks: unmap.completedTicks,
        ordering: 'after',
      },
    ]);
    expect(map.coverage).toBe('full_observed_intersection');
    expect(map.coveredBytes).toBe('4096');
  }
  expect(summary).toMatchObject({
    completeProcess: false,
    completeResources: false,
    formalQualified: false,
    liveAllocations: null,
    businessOwner: null,
  });
});

test('dense overlapping output remains bounded instead of truncating or increasing the work limit', () => {
  expect(() => analyzeVmObserverTrace(intervalTrace(512, true), 20_000)).toThrow(
    'vm_observer_analysis_limit',
  );
  expect(() => analyzeVmObserverTrace(intervalTrace(1), 100_000_001)).toThrow(
    'vm_observer_limit_invalid',
  );
});

test('dense remap existence short-circuits while the sparse unmap output remains exact', () => {
  const trace = intervalTrace(8192, true);
  const finalUnmap = trace.events.at(-1)!;
  trace.events = trace.events.filter((event) => event.kind === 'mmap');
  trace.events.push(finalUnmap);
  trace.events.forEach((event, index) => {
    event.sequence = String(index);
  });
  trace.finish.events = String(trace.events.length);
  const summary = analyzeVmObserverTrace(trace);
  expect(summary.mappingIntersections).toHaveLength(8192);
  expect(summary.mappingIntersections.every((map) => map.intersections.length === 1)).toBe(true);
  expect(
    summary.mappingIntersections.every(
      (map) =>
        map.intersections[0]?.sequence === finalUnmap.sequence && map.coveredBytes === '4096',
    ),
  ).toBe(true);
  expect(summary.mappingIntersections.slice(0, -1).every((map) => map.coverage === 'unknown')).toBe(
    true,
  );
  expect(summary.mappingIntersections.at(-1)?.coverage).toBe('full_observed_intersection');
  expect(summary).toMatchObject({
    formalQualified: false,
    liveAllocations: null,
    businessOwner: null,
  });
});

test('address-index traversal preserves trace ordering and prior or concurrent remap ambiguity', () => {
  const trace = intervalTrace(1);
  const template = trace.events[0]!;
  const map = {
    ...template,
    address: '0x20000000000000',
    length: '12288',
    startedTicks: '20',
    completedTicks: '30',
    sequence: '1',
  };
  const prior = { ...map, sequence: '0', startedTicks: '1', completedTicks: '20' };
  const unmaps = [8192n, 0n, 4096n].map((offset, index) => ({
    ...template,
    kind: 'munmap' as const,
    address: `0x${(BigInt(map.address) + offset).toString(16)}`,
    length: '4096',
    startedTicks: String(31 + index * 2),
    completedTicks: String(32 + index * 2),
    sequence: String(index + 2),
  }));
  trace.events = [prior, map, ...unmaps];
  const original = analyzeVmObserverTrace(trace).mappingIntersections[1]!;
  expect(original.intersections.map((event) => event.sequence)).toEqual(['2', '3', '4']);
  expect(original.coverage).toBe('full_observed_intersection');
  expect(original.coveredIntervals).toEqual([{ start: map.address, end: '0x20000000003000' }]);
  const concurrent = { ...prior, completedTicks: '21' };
  trace.events[0] = concurrent;
  expect(analyzeVmObserverTrace(trace).mappingIntersections[1]?.coverage).toBe('unknown');
});

test('one partial intersection cannot mean full coverage and concurrent syscall order remains unknown', () => {
  const records = rows();
  records.splice(16, 1); // Remove second partial unmap, keeping actual first range.
  records.forEach((row, index) => {
    if (index > 0 && row.kind !== 'finish') row.sequence = String(index - 1);
  });
  records.at(-1).events = '16';
  const trace = decodeVmObserverTrace(wire(records));
  const map = analyzeVmObserverTrace(trace).mappingIntersections.find(
    (map) => map.sequence === '12',
  )!;
  expect(map.coveredBytes).toBe('32768');
  expect(map.coverage).toBe('partial_observed_intersection');
  const changed = rows();
  changed[15].thread = '1093848';
  changed[15].startedTicks = changed[13].startedTicks;
  changed[15].completedTicks = String(BigInt(changed[13].completedTicks) + 1n);
  const concurrent = analyzeVmObserverTrace(
    decodeVmObserverTrace(wire(changed)),
  ).mappingIntersections.find((map) => map.sequence === '12')!;
  expect(concurrent.coverage).toBe('unknown');
  expect(concurrent.intersections.some((item) => item.ordering === 'ambiguous')).toBe(true);
});

test('64-bit decimal times addresses lengths and relative PCs never pass through Number', () => {
  const input = altered((records) => {
    const r = records[13];
    r.address = '0x20000000000001';
    r.length = '9007199254740993';
    r.startedTicks = '9007199254740993';
    r.completedTicks = '9007199254740994';
    r.thread = '9007199254740995';
    r.frames[2] = {
      pc: '0x20000000000005',
      base: '0x20000000000001',
      symbolAddress: '0x0',
      image: '/actual/image',
      symbol: null,
    };
  });
  const trace = decodeVmObserverTrace(input),
    summary = analyzeVmObserverTrace(trace);
  expect(trace.events[12]!.length).toBe('9007199254740993');
  expect(summary.callsites.find((site) => site.image === '/actual/image')).toMatchObject({
    thread: '9007199254740995',
    pcRelative: '0x4',
    requestedBytes: '9007199254740993',
  });
});

test('closed protocol rejects incomplete corrupt identity counts frames encoding and syscall bounds', () => {
  for (const edit of [
    (r: ReturnType<typeof rows>) => {
      r.shift();
    },
    (r: ReturnType<typeof rows>) => {
      r.pop();
    },
    (r: ReturnType<typeof rows>) => {
      r[0].version = 2;
    },
    (r: ReturnType<typeof rows>) => {
      r[0].birthBytes = 135;
    },
    (r: ReturnType<typeof rows>) => {
      r[0].birthSeconds = '0';
    },
    (r: ReturnType<typeof rows>) => {
      r[0].birthMicroseconds = '1000000';
    },
    (r: ReturnType<typeof rows>) => {
      r[0].timeDenom = 0;
    },
    (r: ReturnType<typeof rows>) => {
      r[0].timeError = 1;
    },
    (r: ReturnType<typeof rows>) => {
      r[1].pid++;
    },
    (r: ReturnType<typeof rows>) => {
      r.at(-1).pid++;
    },
    (r: ReturnType<typeof rows>) => {
      r.at(-1).events = '18';
    },
    (r: ReturnType<typeof rows>) => {
      r.at(-1).writeErrors = '1';
    },
    (r: ReturnType<typeof rows>) => {
      r[1].threadError = 1;
    },
    (r: ReturnType<typeof rows>) => {
      r[1].sequence = '01';
    },
    (r: ReturnType<typeof rows>) => {
      r[2].sequence = '0';
    },
    (r: ReturnType<typeof rows>) => {
      r[1].startedTicks = `${r[1].completedTicks}0`;
    },
    (r: ReturnType<typeof rows>) => {
      r[1].length = 65536;
    },
    (r: ReturnType<typeof rows>) => {
      r[1].length = '18446744073709551616';
    },
    (r: ReturnType<typeof rows>) => {
      r[1].address = '0x01';
    },
    (r: ReturnType<typeof rows>) => {
      r[1].frames[0].base = '0xffffffffffffffff';
    },
    (r: ReturnType<typeof rows>) => {
      r[1].frames.push(...r[1].frames);
    },
    (r: ReturnType<typeof rows>) => {
      r[1].frameLimit = 25;
    },
    (r: ReturnType<typeof rows>) => {
      r[1].unknown = true;
    },
    (r: ReturnType<typeof rows>) => {
      r[1].errno = 22;
    },
    (r: ReturnType<typeof rows>) => {
      r.at(-2).errno = 0;
    },
    (r: ReturnType<typeof rows>) => {
      r.at(-2).address = '0x0';
    },
  ])
    expect(() => decodeVmObserverTrace(altered(edit))).toThrow();
  expect(() => decodeVmObserverTrace(bytes(calibrationRaw.slice(0, -1)))).toThrow();
  expect(() =>
    decodeVmObserverTrace(bytes(calibrationRaw.replace('"version":1', '"version":1,"version":1'))),
  ).toThrow();
  expect(() => decodeVmObserverTrace(new Uint8Array([0xff, 10]))).toThrow();
  expect(() =>
    decodeVmObserverTrace(bytes(calibrationRaw.replace('"symbol":"trace"', '"symbol":"\\ud800"'))),
  ).toThrow();
});

test('bounds reject excess input records frames and analysis work instead of truncating', () => {
  expect(() => decodeVmObserverTrace(bytes(calibrationRaw), { maxBytes: 100 })).toThrow();
  expect(() => decodeVmObserverTrace(bytes(calibrationRaw), { maxEvents: 16 })).toThrow();
  expect(() => decodeVmObserverTrace(bytes(calibrationRaw), { maxRecordBytes: 100 })).toThrow();
  expect(() => decodeVmObserverTrace(bytes(calibrationRaw), { maxEvents: 0 })).toThrow();
  expect(() => analyzeVmObserverTrace(decodeVmObserverTrace(bytes(calibrationRaw)), 1)).toThrow(
    'vm_observer_analysis_limit',
  );
  const records = rows();
  records.at(-1).nestedCalls = '5';
  expect(analyzeVmObserverTrace(decodeVmObserverTrace(wire(records)))).toMatchObject({
    nestedCalls: '5',
    completeProcess: false,
    completeResources: false,
    formalQualified: false,
  });
});

test('marks retain their labels and overlapping remaps never become a business owner or live block count', () => {
  const records = rows();
  const mark = {
    ...records[17],
    kind: 'mark',
    address: '0x0',
    length: '0',
    arg: 42,
    result: 0,
    errno: 0,
    protection: 0,
    flags: 0,
    offset: '0',
    sequence: '17',
  };
  mark.startedTicks = String(BigInt(mark.completedTicks) + 1n);
  mark.completedTicks = mark.startedTicks;
  records.splice(18, 0, mark);
  records.at(-1).events = '18';
  const summary = analyzeVmObserverTrace(decodeVmObserverTrace(wire(records)));
  expect(summary.count.mark).toBe(1);
  expect(summary.events.at(-1)).toMatchObject({
    kind: 'mark',
    arg: 42,
    address: '0x0',
    length: '0',
  });
  expect(summary.mappingIntersections.find((event) => event.sequence === '3')?.coverage).toBe(
    'unknown',
  );
  expect(summary).toMatchObject({
    liveAllocations: null,
    businessOwner: null,
    formalQualified: false,
  });
});

test('v1 retains absent mmap request addresses as unknown without rewriting calibrated bytes', () => {
  const trace = decodeVmObserverTrace(bytes(calibrationRaw));
  const summary = analyzeVmObserverTrace(trace);
  expect(summary.mmapArgumentCoverage).toBe('returned_ranges_only');
  expect(trace.events.every((event) => event.requestedAddress === undefined)).toBe(true);
  expect(summary.mappingIntersections.every((map) => map.requestedAddress === null)).toBe(true);
  expect(summary.events.every((event) => event.requestedAddress === null)).toBe(true);
  expect(() =>
    decodeVmObserverTrace(
      altered((records) => {
        records[1].requestedAddress = '0x0';
      }),
    ),
  ).toThrow();
});

test('v2 carries exact requested mmap hints separately from actual returned ranges', () => {
  const records = rows();
  records[0].version = 2;
  for (const row of records.slice(1, -1))
    row.requestedAddress = row.kind === 'mmap' ? '0xffffffffffffffff' : '0x0';
  const trace = decodeVmObserverTrace(wire(records));
  const summary = analyzeVmObserverTrace(trace);
  expect(summary.mmapArgumentCoverage).toBe('request_and_return');
  expect(trace.events[12]).toMatchObject({
    requestedAddress: '0xffffffffffffffff',
    address: '0x1040b4000',
    length: '65536',
  });
  expect(summary.mappingIntersections.find((map) => map.sequence === '12')).toMatchObject({
    requestedAddress: '0xffffffffffffffff',
    address: '0x1040b4000',
    coveredBytes: '65536',
  });
  expect(summary).toMatchObject({
    completeProcess: false,
    completeResources: false,
    formalQualified: false,
    liveAllocations: null,
    businessOwner: null,
  });
});

test('v2 requires the exact request field on every event and zero for non mmap records', () => {
  const records = rows();
  records[0].version = 2;
  for (const row of records.slice(1, -1)) row.requestedAddress = '0x0';
  for (const edit of [
    (r: ReturnType<typeof rows>) => {
      delete r[1].requestedAddress;
    },
    (r: ReturnType<typeof rows>) => {
      r[1].requestedAddress = null;
    },
    (r: ReturnType<typeof rows>) => {
      r[1].requestedAddress = '0x10000000000000000';
    },
    (r: ReturnType<typeof rows>) => {
      r[14].requestedAddress = '0x1';
    },
    (r: ReturnType<typeof rows>) => {
      r[1].unknown = true;
    },
    (r: ReturnType<typeof rows>) => {
      r[0].version = 3;
    },
    (r: ReturnType<typeof rows>) => {
      r[0].version = '2';
    },
    (r: ReturnType<typeof rows>) => {
      r[0].version = true;
    },
  ]) {
    const changed = structuredClone(records);
    edit(changed);
    expect(() => decodeVmObserverTrace(wire(changed))).toThrow();
  }
});
