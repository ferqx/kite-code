"""Verify that Bun ran every selected MCP test file on its documented host."""

import sys
import xml.etree.ElementTree as ET


RESOURCES = "apps/service/test/isolated/mcp-resources-prompts.test.ts"
MACOS_CASE = "default stdio resources/prompts use real original live connection, complete low-trust Model body and ordinary records"


def verify(path, files, platform):
    root = ET.parse(path).getroot()
    suites = root.findall("testsuite")
    owners = sorted(s.get("file", "") for s in suites)
    if root.tag != "testsuites" or not files or owners != sorted(files):
        raise ValueError("report must contain exactly the selected test files")
    if (
        any(int(node.get("failures", "-1")) or int(node.get("errors", "0")) for node in [root, *suites])
        or root.find(".//failure") is not None
        or root.find(".//error") is not None
    ):
        raise ValueError("report contains failed test cases")
    for suite in suites:
        owner = suite.get("file")
        positive = False
        native_cases = 0
        for case in suite.findall("testcase"):
            native = owner == RESOURCES and case.get("name") == MACOS_CASE
            native_cases += int(native)
            if case.find("skipped") is not None:
                if platform == "linux" and native:
                    continue
                raise ValueError(f"unexpected skip in {owner}: {case.get('name')}")
            assertions = int(case.get("assertions", "0"))
            if native and assertions < 1:
                raise ValueError("native stdio case has no assertions")
            positive = positive or assertions > 0
        if not positive or (owner == RESOURCES and native_cases != 1):
            raise ValueError(f"missing executed assertions or native stdio case in {owner}")


if __name__ == "__main__":
    try:
        verify(sys.argv[1], sys.argv[2:], sys.platform)
    except (OSError, IndexError, ValueError, ET.ParseError) as error:
        sys.exit(f"Invalid MCP JUnit evidence: {error}")
