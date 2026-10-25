import {
  __commonJS
} from "./chunk-EQCVQC35.js";

// node_modules/fastdom/extensions/fastdom-promised.js
var require_fastdom_promised = __commonJS({
  "node_modules/fastdom/extensions/fastdom-promised.js"(exports, module) {
    !function() {
      var exports2 = {
        initialize: function() {
          this._tasks = /* @__PURE__ */ new Map();
        },
        mutate: function(fn, ctx) {
          return create(this, "mutate", fn, ctx);
        },
        measure: function(fn, ctx) {
          return create(this, "measure", fn, ctx);
        },
        clear: function(promise) {
          var tasks = this._tasks;
          var task = tasks.get(promise);
          this.fastdom.clear(task);
          tasks.delete(promise);
        }
      };
      function create(promised, type, fn, ctx) {
        var tasks = promised._tasks;
        var fastdom = promised.fastdom;
        var task;
        var promise = new Promise(function(resolve, reject) {
          task = fastdom[type](function() {
            tasks.delete(promise);
            try {
              resolve(ctx ? fn.call(ctx) : fn());
            } catch (e) {
              reject(e);
            }
          }, ctx);
        });
        tasks.set(promise, task);
        return promise;
      }
      if ((typeof define)[0] == "f") define(function() {
        return exports2;
      });
      else if ((typeof module)[0] == "o") module.exports = exports2;
      else window.fastdomPromised = exports2;
    }();
  }
});

export {
  require_fastdom_promised
};
//# sourceMappingURL=chunk-2NQGUWPO.js.map
