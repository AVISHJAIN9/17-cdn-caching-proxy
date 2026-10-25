import {
  parse
} from "./chunk-MQWY7Q27.js";
import "./chunk-UXJYR6YF.js";
import "./chunk-FX57VYUS.js";
import "./chunk-WZR457EU.js";
import "./chunk-3LFUBMUR.js";
import "./chunk-UEL7NYYJ.js";
import "./chunk-4RI3RY2B.js";
import "./chunk-BR5CSW63.js";
import "./chunk-ILEHSPZM.js";
import "./chunk-PY74HSHG.js";
import "./chunk-KHZ5P5ED.js";
import "./chunk-BANZ2GRX.js";
import "./chunk-E5XL3356.js";
import "./chunk-VJLTQOXH.js";
import "./chunk-XWP6RWM6.js";
import "./chunk-DVS2CQPF.js";
import "./chunk-LAC2SMJJ.js";
import {
  selectSvgElement
} from "./chunk-N3CWM3W4.js";
import {
  configureSvgSize
} from "./chunk-FYG2XM7L.js";
import {
  log
} from "./chunk-7Z52U4KA.js";
import {
  __name
} from "./chunk-DTCXZATX.js";
import "./chunk-FFWGCFKV.js";
import "./chunk-EQCVQC35.js";

// node_modules/mermaid/dist/chunks/mermaid.core/infoDiagram-27XIBGKW.mjs
var parser = {
  parse: __name(async (input) => {
    const ast = await parse("info", input);
    log.debug(ast);
  }, "parse")
};
var DEFAULT_INFO_DB = {
  version: "11.17.2" + (true ? "" : "-tiny")
};
var getVersion = __name(() => DEFAULT_INFO_DB.version, "getVersion");
var db = {
  getVersion
};
var draw = __name((text, id, version) => {
  log.debug("rendering info diagram\n" + text);
  const svg = selectSvgElement(id);
  configureSvgSize(svg, 100, 400, true);
  const group = svg.append("g");
  group.append("text").attr("x", 100).attr("y", 40).attr("class", "version").attr("font-size", 32).style("text-anchor", "middle").text(`v${version}`);
}, "draw");
var renderer = { draw };
var diagram = {
  parser,
  db,
  renderer
};
export {
  diagram
};
//# sourceMappingURL=infoDiagram-27XIBGKW-EHAHPL4P.js.map
