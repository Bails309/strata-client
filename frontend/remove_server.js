function clearServer(r) {
    delete r.headersOut['Server'];
    delete r.headersOut['X-Powered-By'];
}

export default { clearServer };
