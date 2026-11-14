import fs from 'node:fs';
const p = 'd:\\code\\_annot_baseline\\d6m-e.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
for (const it of j) {
  if (it.pick === '        let raw_filename = "tqdm-4.66.1-py3-none-manylinux') {
    it.nth = 2;
  }
  if (it.pick === '        assert_snapshot!(&formatted_metadata, @"' && it.nth === 2) {
    it.pick = '        assert_snapshot!(&formatted_metadata, @r#"';
    delete it.nth;
  }
}
fs.writeFileSync(p, JSON.stringify(j, null, 2));
console.log('patched');
