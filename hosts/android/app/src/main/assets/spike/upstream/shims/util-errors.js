// dsh:logging-exempt (shim layer)
/**
 * shims/util-errors.js — node:util's system-error faces (the UV errno table
 * plus getSystemErrorName/getSystemErrorMessage), split out of util.js when
 * that file crossed the code-size budget. One-way dependency: nothing here
 * imports util.js; util.js re-exports the faces (and os.js keeps importing
 * the table through util.js's specifier, so no importer changes).
 */

/** node's uv-errno table (Linux values, node's own doc set): number + the
 * message getSystemErrorMessage renders. One table serves BOTH util faces
 * (getSystemErrorName/getSystemErrorMessage — demanded at module scope by
 * the vendored bash-local/subprocess-local spawn result decoders) and the
 * node:os constants.errno map (os.js derives its numbers from here). */
export const UV_ERRNO = {
  E2BIG: [7, 'argument list too long'],
  EACCES: [13, 'permission denied'],
  EADDRINUSE: [48, 'address already in use'],
  EADDRNOTAVAIL: [49, 'cannot assign requested address'],
  EAFNOSUPPORT: [47, 'address family not supported by protocol family'],
  EAGAIN: [35, 'resource temporarily unavailable'],
  EALREADY: [37, 'operation already in progress'],
  EBADF: [9, 'bad file descriptor'],
  EBADMSG: [94, 'bad message'],
  EBUSY: [16, 'resource busy or locked'],
  ECANCELED: [89, 'operation canceled'],
  ECONNABORTED: [53, 'software caused connection abort'],
  ECONNREFUSED: [61, 'connection refused'],
  ECONNRESET: [54, 'connection reset by peer'],
  EDEADLK: [11, 'resource deadlock avoided'],
  EDESTADDRREQ: [39, 'destination address required'],
  EDOM: [33, 'numerical argument out of domain'],
  EDQUOT: [69, 'quota exceeded'],
  EEXIST: [17, 'file already exists'],
  EFAULT: [14, 'bad address in system call argument'],
  EFBIG: [27, 'file too large'],
  EHOSTUNREACH: [65, 'no route to host'],
  EIDRM: [90, 'identifier removed'],
  EILSEQ: [92, 'illegal byte sequence'],
  EINPROGRESS: [36, 'operation now in progress'],
  EINTR: [4, 'interrupted system call'],
  EINVAL: [22, 'invalid argument'],
  EIO: [5, 'i/o error'],
  EISCONN: [56, 'socket is already connected'],
  EISDIR: [21, 'is a directory'],
  ELOOP: [62, 'too many symbolic links encountered'],
  EMFILE: [24, 'too many open files'],
  EMLINK: [31, 'too many links'],
  EMSGSIZE: [40, 'message too long'],
  EMULTIHOP: [95, 'multihop attempted'],
  ENAMETOOLONG: [63, 'file name too long'],
  ENETDOWN: [50, 'network is down'],
  ENETUNREACH: [51, 'network is unreachable'],
  ENFILE: [23, 'file table overflow'],
  ENOBUFS: [55, 'no buffer space available'],
  ENODATA: [96, 'no data available'],
  ENODEV: [19, 'no such device'],
  ENOENT: [2, 'no such file or directory'],
  ENOEXEC: [8, 'exec format error'],
  ENOLCK: [77, 'no locks available'],
  ENOLINK: [97, 'link has been severed'],
  ENOMEM: [12, 'cannot allocate memory'],
  ENOMSG: [91, 'no message of the desired type'],
  ENOPROTOOPT: [42, 'protocol not available'],
  ENOSPC: [28, 'no space left on device'],
  ENOSR: [98, 'no stream resources'],
  ENOSTR: [99, 'not a stream'],
  ENOSYS: [78, 'function not implemented'],
  ENOTCONN: [57, 'socket is not connected'],
  ENOTDIR: [20, 'not a directory'],
  ENOTEMPTY: [66, 'directory not empty'],
  ENOTSOCK: [38, 'socket operation on non-socket'],
  ENOTSUP: [45, 'operation not supported'],
  ENOTTY: [25, 'inappropriate ioctl for device'],
  ENXIO: [6, 'no such device or address'],
  EOPNOTSUPP: [45, 'operation not supported on socket'],
  EOVERFLOW: [84, 'value too large for defined data type'],
  EPERM: [1, 'operation not permitted'],
  EPIPE: [32, 'broken pipe'],
  EPROTO: [100, 'protocol error'],
  EPROTONOSUPPORT: [43, 'protocol not supported'],
  EPROTOTYPE: [41, 'protocol wrong type for socket'],
  ERANGE: [34, 'numerical result out of range'],
  EROFS: [30, 'read-only file system'],
  ESPIPE: [29, 'invalid seek'],
  ESRCH: [3, 'no such process'],
  ESTALE: [70, 'stale file handle'],
  ETIME: [101, 'timer expired'],
  ETIMEDOUT: [60, 'connection timed out'],
  ETXTBSY: [26, 'text file is busy'],
  EWOULDBLOCK: [35, 'operation would block'],
  EXDEV: [18, 'cross-device link not permitted'],
};

const errnoByNumber = (errno) => {
  for (const [name, entry] of Object.entries(UV_ERRNO)) {
    if (entry[0] === errno) return name;
  }
  return undefined;
};

/** getSystemErrorName(errno) / getSystemErrorMessage(errno) — the libuv
 * error-code tables (undefined for an unknown number, node's contract). */
export const getSystemErrorName = (errno) => {
  if (!Number.isInteger(errno)) {
    throw new TypeError(`getSystemErrorName: integer required (got ${typeof errno})`);
  }
  return errnoByNumber(errno);
};
export const getSystemErrorMessage = (errno) => {
  if (!Number.isInteger(errno)) {
    throw new TypeError(`getSystemErrorMessage: integer required (got ${typeof errno})`);
  }
  return UV_ERRNO[errnoByNumber(errno) ?? '']?.[1];
};
