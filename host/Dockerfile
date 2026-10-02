FROM m1k1o/neko:chromium

# Expose Chromium's DevTools port so the DSH browser-use provider can attach
# over CDP and drive the very browser the user watches. Note: upstream neko's
# managed policy forbids DevTools entirely; re-enable it (0 = always available).
COPY --chown=root:root chromium.conf /etc/neko/supervisord/chromium.conf
RUN sed -i 's/"DeveloperToolsAvailability": 2/"DeveloperToolsAvailability": 0/' /etc/chromium/policies/managed/policies.json
