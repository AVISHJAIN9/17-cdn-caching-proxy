import {
  __commonJS
} from "./chunk-EQCVQC35.js";

// node_modules/fastdom/fastdom.js
var require_fastdom = __commonJS({
  "node_modules/fastdom/fastdom.js"(exports, module) {
    !function(win) {
      "use strict";
      var debug = 0 ? console.log.bind(console, "[fastdom]") : function() {
      };
      var raf = win.requestAnimationFrame || win.webkitRequestAnimationFrame || win.mozRequestAnimationFrame || win.msRequestAnimationFrame || function(cb) {
        return setTimeout(cb, 16);
      };
      function FastDom() {
        var self = this;
        self.reads = [];
        self.writes = [];
        self.raf = raf.bind(win);
        debug("initialized", self);
      }
      FastDom.prototype = {
        constructor: FastDom,
        /**
         * We run this inside a try catch
         * so that if any jobs error, we
         * are able to recover and continue
         * to flush the batch until it's empty.
         *
         * @param {Array} tasks
         */
        runTasks: function(tasks) {
          debug("run tasks");
          var task;
          while (task = tasks.shift()) task();
        },
        /**
         * Adds a job to the read batch and
         * schedules a new frame if need be.
         *
         * @param  {Function} fn
         * @param  {Object} ctx the context to be bound to `fn` (optional).
         * @public
         */
        measure: function(fn, ctx) {
          debug("measure");
          var task = !ctx ? fn : fn.bind(ctx);
          this.reads.push(task);
          scheduleFlush(this);
          return task;
        },
        /**
         * Adds a job to the
         * write batch and schedules
         * a new frame if need be.
         *
         * @param  {Function} fn
         * @param  {Object} ctx the context to be bound to `fn` (optional).
         * @public
         */
        mutate: function(fn, ctx) {
          debug("mutate");
          var task = !ctx ? fn : fn.bind(ctx);
          this.writes.push(task);
          scheduleFlush(this);
          return task;
        },
        /**
         * Clears a scheduled 'read' or 'write' task.
         *
         * @param {Object} task
         * @return {Boolean} success
         * @public
         */
        clear: function(task) {
          debug("clear", task);
          return remove(this.reads, task) || remove(this.writes, task);
        },
        /**
         * Extend this FastDom with some
         * custom functionality.
         *
         * Because fastdom must *always* be a
         * singleton, we're actually extending
         * the fastdom instance. This means tasks
         * scheduled by an extension still enter
         * fastdom's global task queue.
         *
         * The 'super' instance can be accessed
         * from `this.fastdom`.
         *
         * @example
         *
         * var myFastdom = fastdom.extend({
         *   initialize: function() {
         *     // runs on creation
         *   },
         *
         *   // override a method
         *   measure: function(fn) {
         *     // do extra stuff ...
         *
         *     // then call the original
         *     return this.fastdom.measure(fn);
         *   },
         *
         *   ...
         * });
         *
         * @param  {Object} props  properties to mixin
         * @return {FastDom}
         */
        extend: function(props) {
          debug("extend", props);
          if (typeof props != "object") throw new Error("expected object");
          var child = Object.create(this);
          mixin(child, props);
          child.fastdom = this;
          if (child.initialize) child.initialize();
          return child;
        },
        // override this with a function
        // to prevent Errors in console
        // when tasks throw
        catch: null
      };
      function scheduleFlush(fastdom) {
        if (!fastdom.scheduled) {
          fastdom.scheduled = true;
          fastdom.raf(flush.bind(null, fastdom));
          debug("flush scheduled");
        }
      }
      function flush(fastdom) {
        debug("flush");
        var writes = fastdom.writes;
        var reads = fastdom.reads;
        var error;
        try {
          debug("flushing reads", reads.length);
          fastdom.runTasks(reads);
          debug("flushing writes", writes.length);
          fastdom.runTasks(writes);
        } catch (e) {
          error = e;
        }
        fastdom.scheduled = false;
        if (reads.length || writes.length) scheduleFlush(fastdom);
        if (error) {
          debug("task errored", error.message);
          if (fastdom.catch) fastdom.catch(error);
          else throw error;
        }
      }
      function remove(array, item) {
        var index = array.indexOf(item);
        return !!~index && !!array.splice(index, 1);
      }
      function mixin(target, source) {
        for (var key in source) {
          if (source.hasOwnProperty(key)) target[key] = source[key];
        }
      }
      var exports2 = win.fastdom = win.fastdom || new FastDom();
      if (typeof define == "function") define(function() {
        return exports2;
      });
      else if (typeof module == "object") module.exports = exports2;
    }(typeof window !== "undefined" ? window : typeof exports != "undefined" ? exports : globalThis);
  }
});

export {
  require_fastdom
};
//# sourceMappingURL=chunk-TGLEYU5X.js.map
