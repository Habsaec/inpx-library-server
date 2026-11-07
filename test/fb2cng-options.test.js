import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  normalizeFb2cngOptions, diffFb2cngOptions, buildFb2cngConfigText, setYamlScalar, fb2cngOptionsFromForm
} from '../src/fb2cng-options.js';

const base = fs.readFileSync(new URL('../converter/fb2cng.yaml', import.meta.url), 'utf8');

test('normalize: bad enum -> default, numbers clamped', () => {
  const o = normalizeFb2cngOptions({ footnotes_mode: 'evil: 1', img_jpeg_quality: 5000, img_scale: 'x', screen_width: 1 });
  assert.equal(o.footnotes_mode, 'float');
  assert.equal(o.img_jpeg_quality, 100);
  assert.equal(o.img_scale, 1);
  assert.equal(o.screen_width, 600);
});

test('defaults match the bundled yaml (empty diff, config unchanged)', () => {
  const o = normalizeFb2cngOptions({});
  assert.deepEqual(diffFb2cngOptions(o), {});
  assert.equal(buildFb2cngConfigText(base, {}).trim(), base.replace(/\r\n/g, '\n').trim());
});

test('overrides patch existing and missing keys', () => {
  const text = buildFb2cngConfigText(base, { footnotes_mode: 'floatRenumbered', img_jpeg_quality: 70, toc_type: 'flat', fix_zip: true, img_scale: 0.5 });
  assert.match(text, /footnotes:\n {4}mode: floatRenumbered/);
  assert.match(text, /jpeg_quality_level: 70/);
  assert.match(text, /scale_factor: 0\.5/);
  assert.match(text, /^ {2}toc_type: flat$/m);
  assert.match(text, /^ {2}fix_zip: true$/m);
  assert.match(text, /title_template: \|/);
});

test('setYamlScalar creates a missing chain', () => {
  const t = setYamlScalar('version: 1\n', 'document.images.screen.width', '800');
  assert.equal(t, 'version: 1\ndocument:\n  images:\n    screen:\n      width: 800');
});

test('form parsing: unchecked checkbox = false', () => {
  const o = fb2cngOptionsFromForm({ fb2cng_annotation: '1', fb2cng_footnotes_mode: 'default' });
  assert.equal(o.annotation, true);
  assert.equal(o.page_map, false);
  assert.equal(o.footnotes_mode, 'default');
});

test('1.9 options: patched into the right sections, enums validated', async () => {
  const o = normalizeFb2cngOptions({ kfx_compression: 'lzma', pdf_page_frame: '1pt', md_images: 'external', cover_resize: 'fit', screen_dpi: 9999 });
  assert.equal(o.kfx_compression, 'lzma');
  assert.equal(o.pdf_page_frame, '1pt');
  assert.equal(o.md_images, 'placeholder'); // external is not offered (writes a directory)
  assert.equal(o.cover_resize, 'fit');
  assert.equal(o.screen_dpi, 600);
  const text = buildFb2cngConfigText(base, o);
  assert.match(text, /^ {2}kfx:\n {4}compression: lzma$/m);
  assert.match(text, /^ {2}pdf:\n {4}page_frame: 1pt$/m);
  assert.match(text, /resize: fit/);
  assert.doesNotMatch(text, /backlinks:/);
});

import { setYamlValue, readYamlText, cleanTemplateText, FB2CNG_OPTION_DEFS } from '../src/fb2cng-options.js';
import { fbcAssetName, compareVersions } from '../src/fb2cng-binary.js';

test('templates are written as a fixed-indent block scalar and read back unchanged', () => {
  const tpl = '  {{- if .X -}}\n    indented: #not a comment\n{{- end -}}\n\n"quoted": \'x\'';
  const text = setYamlValue(base, 'document.metainformation.title_template', { block: tpl });
  assert.equal(readYamlText(text, 'document.metainformation.title_template'), tpl.trim());
  // the neighbouring key survives
  assert.match(text, /creator_name_template: \|/);
  // a key that did not exist is created as a block too
  const added = setYamlValue('version: 1\n', 'document.toc_page.authors_template', { block: 'a\nb' });
  assert.equal(added, 'version: 1\ndocument:\n  toc_page:\n    authors_template: |2-\n      a\n      b');
});

test('free text is cleaned: control chars, CR, tabs, trailing blanks, length', () => {
  assert.equal(cleanTemplateText('a\r\nb \t\u0007\n\tc'), 'a\nb\n    c');
  assert.equal(cleanTemplateText('x'.repeat(5000)).length, 4000);
});

test('vignettes are written only when built-in; custom CSS becomes a quoted path', () => {
  const text = buildFb2cngConfigText(base, { vg_chapter_top: 'builtin', custom_css: 'p{}' }, { cssPath: 'C:/data/css-1.css' });
  assert.match(text, /^ {2}vignettes:\n {4}chapter:\n {6}title_top: builtin$/m);
  assert.match(text, /^ {2}stylesheet_path: "C:\/data\/css-1\.css"$/m);
  assert.ok(!/vignettes:[\s\S]*book:/.test(buildFb2cngConfigText(base, {})));
  assert.ok(FB2CNG_OPTION_DEFS.filter((d) => d.group === 'vignettes').length === 8);
});

test('fbc asset names and version compare', () => {
  assert.equal(fbcAssetName('win32', 'x64'), 'fbc-windows-amd64.zip');
  assert.equal(fbcAssetName('linux', 'arm64'), 'fbc-linux-arm64.zip');
  assert.equal(fbcAssetName('darwin', 'ia32'), '');
  assert.equal(fbcAssetName('freebsd', 'x64'), '');
  assert.ok(compareVersions('v1.10.0', '1.9.5') > 0);
  assert.ok(compareVersions('1.9.5', '1.9.5') === 0);
});

import { saveVignetteImage, getVignetteDir } from '../src/fb2cng-options.js';

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('uploaded vignette: type sniffed from bytes, stored by hash, written into the config as a path', async () => {
  const token = await saveVignetteImage(PNG_1X1);
  assert.match(token, /^file:[0-9a-f]{16}\.png$/);
  assert.ok(fs.existsSync(`${getVignetteDir()}/${token.slice(5)}`));
  await assert.rejects(() => saveVignetteImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), /BAD_TYPE/);
  await assert.rejects(() => saveVignetteImage(Buffer.alloc(2 * 1024 * 1024, 1)), /TOO_BIG/);
  assert.equal(normalizeFb2cngOptions({ vg_book_top: '../../etc/passwd' }).vg_book_top, 'off');
  assert.equal(normalizeFb2cngOptions({ vg_book_top: token }).vg_book_top, token);
  const text = buildFb2cngConfigText(base, { vg_book_top: token });
  assert.match(text, new RegExp(`title_top: ".*${token.slice(5)}"`));
});
