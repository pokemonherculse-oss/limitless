"""Minimal private GitHub repository backing store for one Excel workbook.

Only the server uses GITHUB_TOKEN. Never put credentials in the frontend.
The GitHub repo must be a *different* repository from Render's code repo,
otherwise updating the workbook can trigger unwanted Render redeploys.
"""
from __future__ import annotations

import base64
import json
import os
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


class GitHubStorageError(RuntimeError):
    pass


class GitHubExcel:
    def __init__(self, repository: str, token: str, branch: str = 'main', path: str = 'limitless.xlsx'):
        parts = repository.strip().split('/')
        if len(parts) != 2 or not all(parts) or '\\' in repository:
            raise GitHubStorageError('GITHUB_DATA_REPO must be owner/repository')
        self.repository = '/'.join(quote(part, safe='') for part in parts)
        self.token = token.strip()
        self.branch = branch.strip()
        self.path = '/'.join(quote(part, safe='') for part in path.strip('/').split('/'))
        self.sha = None
        if not self.token or not self.branch or not self.path:
            raise GitHubStorageError('GitHub repository, token, branch and workbook path are required')

    @classmethod
    def from_environment(cls):
        repo = os.getenv('GITHUB_DATA_REPO', '').strip()
        token = os.getenv('GITHUB_TOKEN', '').strip()
        if not repo and not token:
            return None  # Local-only mode for development or permanent disk hosts.
        if not repo or not token:
            raise GitHubStorageError('Set BOTH GITHUB_DATA_REPO and GITHUB_TOKEN on Render.')
        return cls(repo, token, os.getenv('GITHUB_DATA_BRANCH', 'main'),
                   os.getenv('GITHUB_EXCEL_FILE', 'limitless.xlsx'))

    def _request(self, path, method='GET', payload=None):
        headers = {
            'Accept': 'application/vnd.github+json',
            'Authorization': 'Bearer ' + self.token,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'LIMITLESS-Tournament/1.0',
        }
        body = json.dumps(payload).encode() if payload is not None else None
        if body is not None:
            headers['Content-Type'] = 'application/json'
        url = 'https://api.github.com' + path
        for attempt in range(3):
            try:
                with urlopen(Request(url, data=body, headers=headers, method=method), timeout=12) as response:
                    result = response.read()
                    return response.status, json.loads(result) if result else {}
            except HTTPError as exc:
                detail = exc.read(4096).decode('utf-8', 'replace')
                if exc.code == 404:
                    return 404, None
                if exc.code in (429, 500, 502, 503, 504) and attempt < 2:
                    time.sleep(0.5 * (attempt + 1))
                    continue
                if exc.code in (401, 403):
                    raise GitHubStorageError('GitHub denied workbook access: verify token Contents read/write permission, expiry and repository selection.') from exc
                if exc.code in (409, 422):
                    raise GitHubStorageError('GitHub workbook update conflict; no data was saved. Retry the action.') from exc
                raise GitHubStorageError(f'GitHub returned HTTP {exc.code}: {detail[:220]}') from exc
            except (URLError, OSError, TimeoutError) as exc:
                if attempt < 2:
                    time.sleep(0.5 * (attempt + 1))
                    continue
                raise GitHubStorageError('Cannot reach GitHub to save the Excel workbook. Please retry.') from exc

    def fetch(self):
        """Download the private workbook (or return None for brand-new repos)."""
        status, _ = self._request(f'/repos/{self.repository}')
        if status == 404:
            raise GitHubStorageError('GITHUB_DATA_REPO does not exist or the token cannot access it.')
        status, obj = self._request(f'/repos/{self.repository}/contents/{self.path}?ref={quote(self.branch, safe="")}')
        if status == 404:
            self.sha = None
            return None
        if not isinstance(obj, dict) or obj.get('type') != 'file':
            raise GitHubStorageError('Configured Excel path is not a normal file.')
        if obj.get('encoding') != 'base64' or not obj.get('content'):
            raise GitHubStorageError('GitHub did not return workbook bytes. Workbook may be too large for the Contents API.')
        self.sha = obj['sha']
        try:
            return base64.b64decode(obj['content'])
        except Exception as exc:
            raise GitHubStorageError('Could not decode Excel workbook from GitHub.') from exc

    def store(self, raw: bytes, revision: int):
        payload = {
            'message': f'LIMITLESS: save tournament data (revision {revision})',
            'content': base64.b64encode(raw).decode('ascii'),
            'branch': self.branch,
        }
        if self.sha:
            payload['sha'] = self.sha
        status, obj = self._request(f'/repos/{self.repository}/contents/{self.path}', method='PUT', payload=payload)
        if status != 404 and isinstance(obj, dict) and obj.get('content', {}).get('sha'):
            self.sha = obj['content']['sha']
            return
        raise GitHubStorageError('GitHub did not confirm saving the workbook.')
