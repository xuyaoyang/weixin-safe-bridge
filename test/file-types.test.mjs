import assert from "node:assert/strict";
import test from "node:test";

import { detectAllowedFile } from "../src/policy.mjs";

test("常用工程文件按扩展名和内容特征联合识别", () => {
  const cases = [
    [Buffer.concat([Buffer.from("AC1032", "ascii"), Buffer.alloc(58)]), "drawing.dwg", ".dwg", "application/vnd.dwg"],
    [Buffer.from("0\r\nSECTION\r\n2\r\nHEADER\r\n0\r\nEOF\r\n", "ascii"), "drawing.dxf", ".dxf", "application/dxf"],
    [Buffer.from("ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;\n", "ascii"), "part.step", ".step", "model/step"],
    [Buffer.from("ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;\n", "ascii"), "model.ifc", ".ifc", "application/ifc"],
    [Buffer.from("solid part\nfacet normal 0 0 1\nendfacet\nendsolid part\n", "ascii"), "part.stl", ".stl", "model/stl"],
    [Buffer.from("name,value\n阻尼器,1\n", "utf8"), "data.csv", ".csv", "text/csv"],
    [Buffer.from("# 试验记录\n", "utf8"), "record.md", ".md", "text/markdown"],
    [Buffer.from('{"status":"ok"}\n', "utf8"), "data.json", ".json", "application/json"],
    [Buffer.from("PK\x03\x04[Content_Types].xml ppt/slides/slide1.xml", "binary"), "slides.pptx", ".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ];

  for (const [buffer, filename, extension, mimeType] of cases) {
    assert.deepEqual(detectAllowedFile(buffer, filename), { extension, mimeType }, filename);
  }
});

test("DWG 扩展名不能替代内容特征，宏文档仍失败关闭", () => {
  assert.throws(
    () => detectAllowedFile(Buffer.from("not a drawing", "utf8"), "fake.dwg"),
    (error) => error.code === "UNSUPPORTED_FILE_TYPE",
  );
  assert.throws(
    () => detectAllowedFile(Buffer.from("PK\x03\x04[Content_Types].xml word/document.xml", "binary"), "macro.docm"),
    (error) => error.code === "BLOCKED_FILE_EXTENSION",
  );
});
