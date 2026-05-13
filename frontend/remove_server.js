function clearServer(r) {
    r.headersOut['Server'] = '';
    r.headersOut['X-Powered-By'] = '';
}

export default { clearServer };
