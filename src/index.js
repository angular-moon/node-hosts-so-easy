import fs from 'fs';

import atomicWrite from 'atomic-write';
import debounce from 'lodash/debounce';
import EventEmitter from 'eventemitter3';

const win = process.env === 'win32';
const DEFAULT_EOL = win ? '\r\n' : '\n';
const DEFAULT_HOSTS = win ? 'C:/Windows/System32/drivers/etc/hosts' : '/etc/hosts';

function arrayJoinFunc(arr, separatorFunc) {
  return arr.map(
    (el, i) => el + (i < arr.length-1 ? separatorFunc(el, i) : '')
  ).join('');
}

class Hosts extends EventEmitter {

  /* --- PUBLIC API --- */

  constructor(options) {
    super();

    this.writeInProgress = false;
    this.queue = { add: {}, remove: {}, removeHost: {} };
    this.hostsFile = {};

    const config = this.config = {
      atomicWrites: true,
      debounceTime: 500,
      hostsFile: DEFAULT_HOSTS,
      noWrites: false,
      EOL:  DEFAULT_EOL,
    };

    if (options) {
      for (const key in options) {
        if (typeof config[key] !== 'undefined')
          config[key] = options[key];
        else
          throw new Error("No such config option: " + key);
      }
    }

    this.writeFile = config.atomicWrites
      ? atomicWrite.writeFile.bind(atomicWrite)
      : fs.writeFile.bind(fs);

    this.queueWrite = this.noWrites
      ? function() {}
      : debounce(this._write, config.debounceTime);
  }

  add(ip, host) {
    const queue = this.queue;

    if (!this.queue.add[ip])
      queue.add[ip] = [];

    if (typeof host === 'object')
      queue.add[ip] = queue.add[ip].concat(host);
    else
      queue.add[ip].push(host);

    this.queueWrite();
  }

  remove(ip, host) {
    const queue = this.queue;

    if (!queue.remove[ip])
      queue.remove[ip] = [];

    // skip if we already have a '*'
    if (typeof queue.remove[ip] === 'string')
      return;

    if (host === '*')
      queue.remove[ip] = '*';
    else if (typeof host === 'object')
      queue.remove[ip] = queue.add[ip].concat(host);
    else
      queue.remove[ip].push(host);

    this.queueWrite();
  }

  removeHost(host) {
    this.queue.removeHost[host] = true;
    this.queueWrite();
  }

  clearQueue() {
    this.queue.add = {};
    this.queue.remove = {};
    this.queue.removeHost = {};
  }

  postWrite() {
    return new Promise((resolve, reject) => {
      // Ok for now, could handle reject with a bit more effort.
      this.once('writeSuccess', resolve);
    });
  }

  /* --- INTERNAL API --- */

  modify(input) {
    const queue = this.queue;
    const arr = input.split(/\r?\n/).map(line => {
      if (line === '' || line.startsWith('#'))
        return line;

      let hosts = line.split(/[\s]+/);
      const whitespace = line.match(/\s+/g).slice();
      const ip = hosts.shift();

      // removeHost
      hosts = hosts.filter(x => !queue.removeHost[x]);
      queue.removeHost = {};

      if (queue.add[ip]) {
        hosts = hosts.concat(queue.add[ip].filter(x => !hosts.includes(x)));
        delete queue.add[ip];
      }

      if (queue.remove[ip]) {
        let host;
        while ((host = queue.remove[ip].pop()))
          hosts = hosts.filter(x => x !== host)
      }

      if (hosts.length)
        return ip +
          (whitespace[0] || ' ') +
          arrayJoinFunc(hosts, (x, i) => whitespace[i+1] || ' ');

      return undefined;
    });

    // Start before trailing newlines and comments
    let startIndex;
    if (arr.length) {
      startIndex = arr.length - 1;
      while (startIndex > 0 && (!arr[startIndex] || arr[startIndex].startsWith('#')))
        startIndex--;
    } else {
      startIndex = 0;
    }

    // TODO: try mimic preceeding whitespace pattern?
    for (const ip in queue.add)
      arr.splice(++startIndex, 0, ip + ' ' + queue.add[ip].join(' '));

    this.clearQueue();

    return arr.join(this.config.EOL);
  }

  /* --- FILE MANAGEMENT (INTERNAL) --- */

  _writeContents(contents) {
    this.writeFile(this.config.hostsFile, contents, err => {
      if (err)
        throw err;
      this.writeInProgress = false;
      this.emit('writeSuccess');
    });
  }

  _write() {
    if (this.writeInProgress)
      return this.queueWrite();

    this.writeInProgress = true;
    this.emit('writeStart');

    // Check if file has changed to avoid unnecessary reread.
    fs.stat(this.config.hostsFile, (err, stats) => {
      if (stats.ctimeMs === this.hostsFile.ctimeMs) {

        this._writeContents(this.modify(this.hostsFile.raw));

      } else {

        this.hostsFile.ctimeMs = stats.ctimeMs;
        fs.readFile(this.config.hostsFile, (err, file) => {
          if (err)
            throw err;

          this.hostsFile.raw = file.toString();
          this._writeContents(this.modify(this.hostsFile.raw));
        });

      }
    });
  }

}

export default Hosts;