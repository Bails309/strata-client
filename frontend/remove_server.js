function clearServer(r) {
    r.headersOut['Server'] = 'Strata';
    delete r.headersOut['X-Powered-By'];
}

export default { clearServer };
