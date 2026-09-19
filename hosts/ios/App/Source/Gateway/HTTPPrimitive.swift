import Foundation

/// httpFetch (contract/primitives.md §4) over URLSession. The call settles
/// `{status, headers, bodyId: "body:<callId>"}` when response HEADERS arrive;
/// the body then streams as gateway events — `http.body` chunks (≤16 KB
/// base64) and a final `http.end` — never a blocking whole-result (D8).
/// Failures after the settle ride `http.error` with a GatewayError code
/// (cancelled / timeout / network); failures before headers settle the call
/// itself. Abort cancels the task → stream error code `cancelled`.
final class HTTPPrimitive: NSObject, URLSessionDataDelegate {
    static let chunkLimit = 16 * 1024
    static let bodyPrefix = "body:"

    private let lock = NSLock()
    private var callByTask: [Int: Int] = [:] // URLSessionTask.identifier → callId
    private var taskByCall: [Int: URLSessionDataTask] = [:]
    private var settled: Set<Int> = []
    private var session: URLSession!
    private weak var core: GatewayCore?

    init(core: GatewayCore) {
        self.core = core
        super.init()
        session = URLSession(
            configuration: .ephemeral, delegate: self, delegateQueue: nil)
        core.register(name: "httpFetch") { call, done in self.fetch(call, done) }
        core.register(name: "httpFetch.abort") { call, _ in self.abort(call) }
    }

    // ---- call side -----------------------------------------------------------

    private func fetch(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        guard let urlText = call.string("url"), let url = URL(string: urlText) else {
            return done(.failure(GatewayError(
                code: "invalid", primitive: "httpFetch", message: "malformed url")))
        }
        let initDict = call.dict("init")
        let request = Self.request(url: url, initDict: initDict)
        let task = session.dataTask(with: request)
        lock.lock()
        callByTask[task.taskIdentifier] = call.callId
        taskByCall[call.callId] = task
        lock.unlock()
        task.resume()
    }

    private static func request(url: URL, initDict: [String: Any]) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = initDict["method"] as? String ?? "GET"
        if let headers = initDict["headers"] as? [String: String] {
            for (field, value) in headers { request.setValue(value, forHTTPHeaderField: field) }
        }
        // Contract HttpFetchInit.body rides base64 as init.bodyB64.
        if let text = initDict["bodyB64"] as? String ?? initDict["body"] as? String,
           let body = Data(base64Encoded: text) {
            request.httpBody = body
        }
        return request
    }

    /// Control-plane abort of the frozen bridge: cancels the in-flight task;
    /// idempotent (no task → nothing to cancel). The target callId arrives
    /// as the number `callId`; shims may also pass the response's bodyId
    /// string ("body:<callId>"), which is accepted tolerantly.
    private func abort(_ call: GatewayCall) {
        let target: Int
        if let n = call.args["callId"] as? Int {
            target = n
        } else if let s = call.args["callId"] as? String,
                  s.hasPrefix(Self.bodyPrefix),
                  let n = Int(s.dropFirst(Self.bodyPrefix.count)) {
            target = n
        } else {
            target = call.callId
        }
        lock.lock()
        let task = taskByCall[target]
        lock.unlock()
        task?.cancel()
    }

    // ---- URLSessionDataDelegate (session's private serial queue) -------------

    func urlSession(
        _ session: URLSession, dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard let callId = callId(for: dataTask) else {
            return completionHandler(.cancel)
        }
        let http = response as? HTTPURLResponse
        var headers: [String: String] = [:]
        for (field, value) in http?.allHeaderFields ?? [:] {
            headers["\(field)"] = "\(value)"
        }
        markSettled(callId)
        // The fetch settles at headers (the body streams as events), so the
        // mandatory audit fires here, not in the registration's done path.
        core?.audit(primitive: "httpFetch", verdict: "granted", outcome: "ok")
        let payload: [String: Any] = [
            "status": http?.statusCode ?? 0,
            "headers": headers,
            "bodyId": Self.bodyPrefix + String(callId),
        ]
        core?.settle?(callId, true, GatewayCore.encode(payload))
        completionHandler(.allow)
    }

    func urlSession(
        _ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data
    ) {
        guard let callId = callId(for: dataTask) else { return }
        var offset = 0
        while offset < data.count {
            let end = min(offset + Self.chunkLimit, data.count)
            let chunk = data.subdata(in: offset..<end)
            offset = end
            emit(["event": "http.body", "callId": callId,
                  "chunkB64": chunk.base64EncodedString()])
        }
    }

    func urlSession(
        _ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?
    ) {
        guard let callId = callId(for: task) else { return }
        defer { forget(callId: callId, taskIdentifier: task.taskIdentifier) }
        guard let error else {
            if isSettled(callId) { emit(["event": "http.end", "callId": callId]) }
            return
        }
        let code = Self.errorCode(error)
        if isSettled(callId) {
            emit(["event": "http.error", "callId": callId, "code": code,
                  "message": error.localizedDescription])
        } else {
            markSettled(callId)
            core?.audit(primitive: "httpFetch", verdict: "granted", outcome: code)
            core?.settle?(callId, false, GatewayCore.errorJSON(GatewayError(
                code: code, primitive: "httpFetch", message: error.localizedDescription)))
        }
    }

    // ---- plumbing ------------------------------------------------------------

    private func callId(for task: URLSessionTask) -> Int? {
        lock.lock()
        defer { lock.unlock() }
        return callByTask[task.taskIdentifier]
    }

    private func isSettled(_ callId: Int) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return settled.contains(callId)
    }

    private func markSettled(_ callId: Int) {
        lock.lock()
        settled.insert(callId)
        lock.unlock()
    }

    private func forget(callId: Int, taskIdentifier: Int) {
        lock.lock()
        callByTask[taskIdentifier] = nil
        taskByCall[callId] = nil
        settled.remove(callId)
        lock.unlock()
    }

    private func emit(_ obj: [String: Any]) {
        guard let line = GatewayCore.jsonLine(obj) else { return }
        core?.emit?(line)
    }

    private static func errorCode(_ error: Error) -> String {
        switch (error as? URLError)?.code {
        case .timedOut: return "timeout"
        case .cancelled: return "cancelled"
        default: return "network"
        }
    }
}
