"""Two-paragraph DOCX test oracle only; not a general Office comparison engine."""
import datetime
import hashlib
import re
import sys
import zipfile
import xml.etree.ElementTree as E

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
W14 = '{http://schemas.microsoft.com/office/word/2010/wordml}'
CP = '{http://schemas.openxmlformats.org/officeDocument/2006/custom-properties}'
VT = '{http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes}'

def load(path):
    with zipfile.ZipFile(path) as z:
        return {n: z.read(n) for n in z.namelist()}

# Synthetic external-origin source: no editor custom-property part yet.
REL = '{http://schemas.openxmlformats.org/package/2006/relationships}'
CT = '{http://schemas.openxmlformats.org/package/2006/content-types}'
CUSTOM_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties'
CUSTOM_MIME = 'application/vnd.openxmlformats-officedocument.custom-properties+xml'

def without_custom(parts):
    result = dict(parts)
    del result['docProps/custom.xml']
    for part, tag, field, value in [('_rels/.rels', REL+'Relationship', 'Type', CUSTOM_TYPE),
                                   ('[Content_Types].xml', CT+'Override', 'PartName', '/docProps/custom.xml')]:
        root = E.fromstring(result[part])
        selected = [e for e in root if e.tag == tag and e.attrib.get(field) == value]
        assert len(selected) == 1
        root.remove(selected[0])
        E.register_namespace('', REL[1:-1] if part.endswith('.rels') else CT[1:-1])
        result[part] = E.tostring(root)
    return result

if sys.argv[1] == '--without-custom':
    with zipfile.ZipFile(sys.argv[3], 'w') as z:
        for name, data in without_custom(load(sys.argv[2])).items():
            z.writestr(name, data)
    sys.exit(0)

def checked_added_custom(parts):
    root = E.fromstring(parts['docProps/custom.xml'])
    assert root.tag == CP+'Properties' and not root.attrib and len(root) == 2
    props = {e.attrib.get('name'): e for e in root}
    assert set(props) == {'OfficeCLI.Version', 'OfficeCLI.LastModified'}
    pids = set()
    for name, e in props.items():
        assert e.tag == CP+'property'
        assert set(e.attrib) == {'fmtid', 'pid', 'name'}
        assert e.attrib['fmtid'].upper() == '{D5CDD505-2E9C-101B-9397-08002B2CF9AE}'
        assert e.attrib['pid'].isdigit() and int(e.attrib['pid']) >= 2
        pids.add(e.attrib['pid'])
        assert len(e) == 1 and e[0].tag == VT+'lpwstr' and not e[0].attrib
    assert len(pids) == 2
    assert props['OfficeCLI.Version'][0].text == '1.0.160'
    value = props['OfficeCLI.LastModified'][0].text
    assert re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', value or '')
    datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
    rel = [e for e in E.fromstring(parts['_rels/.rels']) if e.attrib.get('Type') == CUSTOM_TYPE]
    assert len(rel) == 1 and rel[0].tag == REL+'Relationship'
    ids = [e.attrib.get('Id') for e in E.fromstring(parts['_rels/.rels'])]
    assert all(ids) and len(ids) == len(set(ids))
    assert set(rel[0].attrib) == {'Id', 'Type', 'Target'} and rel[0].attrib['Target'] == '/docProps/custom.xml'
    ct = [e for e in E.fromstring(parts['[Content_Types].xml']) if e.attrib.get('PartName') == '/docProps/custom.xml']
    assert len(ct) == 1 and ct[0].tag == CT+'Override'
    assert ct[0].attrib == {'PartName': '/docProps/custom.xml', 'ContentType': CUSTOM_MIME}
    return without_custom(parts)

def canon(e):
    return e.tag, sorted(e.attrib.items()), e.text or '', e.tail or '', [canon(c) for c in e]

def accepts(a, b):
    try:
        if 'docProps/custom.xml' not in a and 'docProps/custom.xml' in b:
            b = checked_added_custom(b)
        assert a.keys() == b.keys()
        for part in a:
            if not part.endswith(('.xml', '.rels')):
                assert a[part] == b[part]
                continue
            x, y = E.fromstring(a[part]), E.fromstring(b[part])
            if part == 'word/document.xml':
                px, py = [r.findall(W+'body/'+W+'p') for r in (x, y)]
                assert len(px) == len(py) == 2
                old, new = px[0].findall('.//'+W+'t'), py[0].findall('.//'+W+'t')
                assert len(old) == len(new) == 1
                assert old[0].text == 'Target before' and new[0].text == 'Target after'
                old[0].text = 'Target after'
                # Only the target paragraph's exact text-revision attribute is variable.
                key = W14+'textId'
                assert (key in px[0].attrib) == (key in py[0].attrib)
                if key in px[0].attrib:
                    assert all(re.fullmatch('[0-9A-Fa-f]{8}', p.attrib[key]) for p in (px[0], py[0]))
                    px[0].attrib[key] = py[0].attrib[key]
            if part == 'docProps/custom.xml':
                selected = [[e for e in r if e.tag == CP+'property' and e.attrib.get('name') == 'OfficeCLI.LastModified'] for r in (x, y)]
                assert len(selected[0]) == len(selected[1]) == 1
                old, new = selected[0][0], selected[1][0]
                assert old.attrib == new.attrib and len(old) == len(new) == 1
                assert old[0].tag == new[0].tag == VT+'lpwstr'
                for value in (old[0].text, new[0].text):
                    assert re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', value or '')
                    datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
                old[0].text = new[0].text
            assert canon(x) == canon(y), part
        return True
    except (AssertionError, ValueError, TypeError):
        return False

a, b = load(sys.argv[1]), load(sys.argv[2])
assert hashlib.sha256(open(sys.argv[1], 'rb').read()).hexdigest() == sys.argv[3]
assert accepts(a, b), 'real helper edit exceeds narrow allowance'

if 'docProps/custom.xml' not in a:
    altered = dict(b)
    altered['unexplained.xml'] = b'<unexpected/>'
    assert not accepts(a, altered)
    mutations = [
        ('docProps/custom.xml', lambda r: E.SubElement(r, CP+'property', {'name': 'Unexplained'})),
        ('docProps/custom.xml', lambda r: setattr(r[0][0], 'text', 'unexplained-value')),
        ('_rels/.rels', lambda r: next(e for e in r if e.attrib.get('Type') == CUSTOM_TYPE).set('Target', 'wrong.xml')),
        ('[Content_Types].xml', lambda r: next(e for e in r if e.attrib.get('PartName') == '/docProps/custom.xml').set('ContentType', 'wrong/type')),
        ('word/document.xml', lambda r: setattr(r.findall('.//'+W+'t')[1], 'text', 'Collateral')),
        ('word/styles.xml', lambda r: r.set('unexpected', 'true')),
        ('word/_rels/document.xml.rels', lambda r: r[0].set('Target', 'wrong.xml')),
    ]
    for part, change in mutations:
        altered = dict(b)
        root = E.fromstring(altered[part])
        change(root)
        altered[part] = E.tostring(root)
        assert not accepts(a, altered), part
    print('new editor part accepted; 8 unexplained part/content/relationship mutations rejected')
    sys.exit(0)

# Exercise allowed value differences even if two helper saves share a timestamp.
allowed = dict(b)
r = E.fromstring(allowed['word/document.xml'])
target = r.findall(W+'body/'+W+'p')[0]
assert W14+'textId' in target.attrib
target.set(W14+'textId', '0123ABCD')
allowed['word/document.xml'] = E.tostring(r)
r = E.fromstring(allowed['docProps/custom.xml'])
next(e for e in r if e.attrib.get('name') == 'OfficeCLI.LastModified')[0].text = '2026-11-14T12:34:56Z'
allowed['docProps/custom.xml'] = E.tostring(r)
assert accepts(a, allowed), 'scoped valid metadata should be accepted'


def mutation(part, change):
    altered = dict(b)
    root = E.fromstring(altered[part])
    change(root)
    altered[part] = E.tostring(root)
    assert not accepts(a, altered), 'unexpected acceptance: '+part

mutation('word/document.xml', lambda r: r.findall(W+'body/'+W+'p')[1].set(W14+'textId', 'BAD0C0DE'))
mutation('word/document.xml', lambda r: r.findall(W+'body/'+W+'p')[0].set(W14+'textId', 'not-a-hex-id'))
mutation('word/document.xml', lambda r: r.findall(W+'body/'+W+'p')[0].set(W14+'paraId', 'BAD0C0DE'))
mutation('word/document.xml', lambda r: setattr(r.findall('.//'+W+'t')[1], 'text', 'Collateral edit'))
mutation('word/document.xml', lambda r: E.SubElement(r.find(W+'body'), W+'tbl'))
mutation('word/styles.xml', lambda r: r.set('unexpected-style-change', 'true'))
mutation('word/_rels/document.xml.rels', lambda r: r[0].set('Target', 'wrong-target'))
for field in ('name', 'pid', 'fmtid'):
    mutation('docProps/custom.xml', lambda r, f=field: next(e for e in r if e.attrib.get('name') == 'OfficeCLI.LastModified').set(f, 'changed'))
mutation('docProps/custom.xml', lambda r: setattr(next(e for e in r if e.attrib.get('name') == 'OfficeCLI.LastModified')[0], 'tag', VT+'filetime'))
mutation('docProps/custom.xml', lambda r: setattr(next(e for e in r if e.attrib.get('name') == 'OfficeCLI.LastModified')[0], 'text', 'invalid-time'))
mutation('docProps/custom.xml', lambda r: E.SubElement(r, CP+'property', {'name': 'Unexplained'}))
print('real DOCX edit accepted; 13 collateral/invalid mutations rejected; original hash preserved')
