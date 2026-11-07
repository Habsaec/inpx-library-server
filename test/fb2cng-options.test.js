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
  assert.ok(FB2CNG_OPTION_DEFS.filter((d) => d.type === 'vignette').length === 8);
});

test('vignette width is a CSS rule on top of a stylesheet, never a YAML key', async () => {
  const { fb2cngExtraCss } = await import('../src/fb2cng-options.js');
  assert.equal(fb2cngExtraCss({}), '');
  assert.match(fb2cngExtraCss({ vg_width: '33' }), /img\.image-vignette \{ width: 33%; height: auto; \}/);
  assert.match(fb2cngExtraCss({ vg_width: 'auto' }), /width: auto; max-width: 100%;/);
  assert.equal(normalizeFb2cngOptions({ vg_width: '200' }).vg_width, 'full');
  const text = buildFb2cngConfigText(base, { vg_width: '50' });
  assert.ok(!/vg_width|image-vignette/.test(text));
  // with a generated stylesheet the config points at it even without own CSS
  assert.match(buildFb2cngConfigText(base, { vg_width: '50' }, { cssPath: 'C:/d/css-2.css' }), /^ {2}stylesheet_path: "C:\/d\/css-2\.css"$/m);
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

test('fonts: TTF / OTF only, @font-face per face, separate rules for text, headings and drop cap', async () => {
  const { saveFontFile, fb2cngExtraCss, fb2cngUsedFonts } = await import('../src/fb2cng-options.js');
  const ttf = Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.alloc(64, 7)]);
  const otf = Buffer.concat([Buffer.from('OTTO', 'latin1'), Buffer.alloc(64, 9)]);
  const tText = await saveFontFile(ttf, 'Text.ttf');
  const tDrop = await saveFontFile(otf, 'Drop.otf');
  assert.match(tText, /^font:[0-9a-f]{16}\.ttf$/);
  assert.match(tDrop, /^font:[0-9a-f]{16}\.otf$/);
  await assert.rejects(() => saveFontFile(Buffer.from('wOFF0000000000000000'), 'x.woff'), /BAD_TYPE/);
  assert.equal(normalizeFb2cngOptions({ font_text_regular: '../x.ttf' }).font_text_regular, '');
  const css = fb2cngExtraCss({
    font_text_family: 'custom', font_text_regular: tText, font_text_size: '110',
    font_head_family: 'sans-serif', font_head_size: '125',
    font_drop_family: 'custom', font_drop_regular: tDrop, font_drop_size: '4'
  });
  assert.ok(css.includes(`@font-face { font-family: "INPX Text"; src: url("fonts/${tText.slice(5)}"); font-weight: normal; font-style: normal; }`));
  assert.match(css, /^body \{ font-family: "INPX Text"; font-size: 110%; \}$/m);
  assert.match(css, /\.chapter-title-header, [^{]*\{ font-family: sans-serif; \}/);
  assert.match(css, /\.body-title, \.chapter-title, \.section-title, \.toc-title \{ font-size: 125%; \}/);
  assert.match(css, /p\.has-dropcap \.dropcap \{ font-family: "INPX Dropcap"; font-weight: normal; font-size: 4em; \}/);
  // files of a role that is not set to «own font» are not used
  assert.deepEqual(fb2cngUsedFonts({ font_text_family: 'serif', font_text_regular: tText }), []);
  assert.equal(fb2cngExtraCss({ font_text_family: 'custom' }), ''); // custom without a file = no rule
});

test('corrections: drop cap level with the first line, vignettes centred (PDF: margins in pt)', async () => {
  const { fb2cngFixCss, fb2cngExtraCss, imagePixelWidth } = await import('../src/fb2cng-options.js');
  assert.equal(fb2cngFixCss({}), '');
  assert.match(fb2cngFixCss({ dropcaps: true }), /p\.has-dropcap \.dropcap \{ line-height: 0\.8; \}/);
  assert.match(fb2cngFixCss({ vg_chapter_top: 'builtin' }), /img\.image-vignette \{ display: block; margin-left: auto; margin-right: auto; \}/);
  // 1264 px at 300 dpi = 303.36 pt page, minus 2 × 24 pt = 255.36 pt column; 50 % → 63.8 pt on each side
  const css = fb2cngExtraCss({ vg_width: '50', vg_chapter_top: 'builtin' });
  assert.match(css, /@media fbc-pdf \{\n {2}img\.image-vignette \{ width: 100%; margin-left: 63\.8pt; margin-right: 63\.8pt; \}\n\}/);
  assert.ok(!/fbc-pdf/.test(fb2cngExtraCss({ vg_width: 'full', vg_chapter_top: 'builtin' })));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  assert.equal(imagePixelWidth(png), 1);
  assert.equal(imagePixelWidth(Buffer.from('not an image at all, really not')), 0);
});
