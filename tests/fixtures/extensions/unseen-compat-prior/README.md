# Fixed preexisting counted-tool artifact

`counted-tool-v1.js` is the unchanged byte copy of the preexisting `tests/fixtures/extensions/counted-tool/dist/index.js` observed before this packet's builds. It declares extension version `1.0.0` and imports the public extension entry point. SHA-256 is `6d9ffc07b069d4314970727c0a74ef0b62ed0990e4298805119953c25efda8ef`.

该历史产物不参与 Biome 格式化、导入整理和 lint，以保留原始字节。运行兼容性测试仍在加载前核验原始摘要。

The unseen public test copies these fixed bytes into its external application and verifies the hash before loading them on the current built host. It never rebuilds the prior fixture or substitutes a newly built label. The real Tool runs once with original Ask, returns `counted:prior-bytes`, and records one external invocation. A second readonly host retrieves the original Command/Run with unchanged cursor and ledger and zero Model calls. This is the bounded E11 prior-artifact/current-host consumer check, not a promise of compatibility with every historical release.
