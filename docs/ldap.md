# University sign-in (LDAP / Active Directory)

Students and staff can sign in with their university username and password. The API checks them
against the university directory (OpenLDAP or Microsoft Active Directory). Local accounts created
in the dashboard keep working alongside it.

LDAP is off unless `LDAP_URL` is set.

## How a sign-in works

1. The API connects to the directory: `ldaps://`, or `ldap://` upgraded with StartTLS.
2. It binds as the **service account** (`LDAP_BIND_DN`), or stays anonymous if none is set.
3. It searches `LDAP_USER_BASE` with `LDAP_USER_FILTER`. `{username}` is replaced by the typed
   username, escaped per RFC 4515, so characters like `*` or `)` cannot change the filter. Exactly
   one entry must match.
4. It binds as that entry's DN with the typed password. An empty password is refused before any
   network traffic: many servers accept an empty-password bind as an "unauthenticated bind".
5. It reads the display name and group membership, maps them to a role (see below), and creates or
   updates the user in the `users` table. LDAP users have no local password (`password_hash` is NULL).
   Their display name and role are refreshed on every sign-in.

The whole login has to finish within `LDAP_TIMEOUT_MS`. If the directory is down, slow or
misconfigured, the user sees "wrong username or password" (HTTP 401). The cause goes to the
server log. The directory's error details are never sent to the browser, and passwords are never
logged.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `LDAP_URL` | *(unset = LDAP off)* | `ldaps://host[:636]` or `ldap://host[:389]` |
| `LDAP_BIND_DN` | *(anonymous)* | DN of the read-only service account used to find users |
| `LDAP_BIND_PASSWORD` | | Its password (required if `LDAP_BIND_DN` is set) |
| `LDAP_USER_BASE` | *(required)* | Where users are searched (subtree) |
| `LDAP_USER_FILTER` | `(uid={username})` | Must contain `{username}` |
| `LDAP_DISPLAY_NAME_ATTR` | `displayName` | Falls back to `cn`, then the username |
| `LDAP_GROUP_ATTR` | `memberOf` | Attribute on the user entry listing group DNs |
| `LDAP_ADMIN_GROUPS` | | Group DNs that give the `admin` role |
| `LDAP_INSTRUCTOR_GROUPS` | | … `instructor` |
| `LDAP_AUTHOR_GROUPS` | | … `case_author` |
| `LDAP_STUDENT_GROUPS` | | … `student` |
| `LDAP_DEFAULT_ROLE` | `student` | Role for users in none of the groups above; `none` refuses them |
| `LDAP_TLS_CA` | *(system CAs)* | Path to the PEM CA certificate that signed the directory's certificate |
| `LDAP_STARTTLS` | off | `1` to upgrade `ldap://` with StartTLS (not with `ldaps://`) |
| `LDAP_TIMEOUT_MS` | `5000` | Time limit for one whole sign-in against the directory |

**Group lists are separated by `;`**, not commas, because every DN already contains commas.
Group DNs are compared without regard to letter case or spaces after commas, so
`CN=Sim Admins, OU=Groups, DC=uowa, DC=edu, DC=iq` matches `cn=sim admins,ou=groups,dc=uowa,dc=edu,dc=iq`.

Invalid settings stop the server at startup with a message naming the variable. A missing
`LDAP_TLS_CA` file also stops it.

### Example: Active Directory

```env
LDAP_URL=ldaps://dc1.uowa.edu.iq:636
LDAP_TLS_CA=/run/secrets/uowa-ad-ca.pem
LDAP_BIND_DN=CN=svc-medsim,OU=Service Accounts,DC=uowa,DC=edu,DC=iq
LDAP_BIND_PASSWORD=change-me
LDAP_USER_BASE=OU=People,DC=uowa,DC=edu,DC=iq
LDAP_USER_FILTER=(&(objectClass=user)(sAMAccountName={username})(!(userAccountControl:1.2.840.113556.1.4.803:=2)))
LDAP_DISPLAY_NAME_ATTR=displayName
LDAP_GROUP_ATTR=memberOf
LDAP_ADMIN_GROUPS=CN=MedSim Admins,OU=Groups,DC=uowa,DC=edu,DC=iq
LDAP_INSTRUCTOR_GROUPS=CN=Medicine Staff,OU=Groups,DC=uowa,DC=edu,DC=iq;CN=Clinical Tutors,OU=Groups,DC=uowa,DC=edu,DC=iq
LDAP_AUTHOR_GROUPS=CN=MedSim Case Authors,OU=Groups,DC=uowa,DC=edu,DC=iq
LDAP_STUDENT_GROUPS=CN=Medicine Students,OU=Groups,DC=uowa,DC=edu,DC=iq
LDAP_DEFAULT_ROLE=none
```

The `userAccountControl` clause leaves disabled accounts out. AD's `memberOf` lists only direct
groups, not nested ones, so put people directly in the mapped groups.

### Example: OpenLDAP

```env
LDAP_URL=ldap://ldap.uowa.edu.iq:389
LDAP_STARTTLS=1
LDAP_TLS_CA=/run/secrets/uowa-ca.pem
LDAP_BIND_DN=cn=medsim,ou=service,dc=uowa,dc=edu,dc=iq
LDAP_BIND_PASSWORD=change-me
LDAP_USER_BASE=ou=people,dc=uowa,dc=edu,dc=iq
LDAP_USER_FILTER=(&(objectClass=inetOrgPerson)(uid={username}))
LDAP_ADMIN_GROUPS=cn=medsim-admins,ou=groups,dc=uowa,dc=edu,dc=iq
LDAP_INSTRUCTOR_GROUPS=cn=medicine-staff,ou=groups,dc=uowa,dc=edu,dc=iq
LDAP_AUTHOR_GROUPS=cn=medsim-authors,ou=groups,dc=uowa,dc=edu,dc=iq
LDAP_STUDENT_GROUPS=cn=medicine-students,ou=groups,dc=uowa,dc=edu,dc=iq
```

OpenLDAP has `memberOf` only when the `memberof` overlay is enabled, with `groupOfNames` /
`member` groups. Without the overlay every user gets `LDAP_DEFAULT_ROLE`.

With Docker Compose, add these variables to the `api` service's `environment` in
`docker-compose.yml`, values in `.env`. Also mount the CA file read-only, for example
`./deploy/ldap-ca.pem:/run/secrets/uowa-ca.pem:ro`.

## How roles are assigned

The highest-privilege match wins: **admin > instructor > case_author > student**. For example, a
member of both the student and instructor groups becomes `instructor`. A user in none of the
groups gets `LDAP_DEFAULT_ROLE`: `student` by default, or is refused with `none`.

The role is re-read at every sign-in. Removing someone from a group takes effect at their next
sign-in; a token already issued stays valid until it expires (12 hours). Role changes made in the
dashboard to an LDAP user are overwritten at their next sign-in, so manage LDAP users' roles in
the directory.

## Break-glass local admin

Accounts with a local password (`password_hash` set, for example the admin created with
`npm run seed` or in the dashboard) always sign in locally and never contact the directory.
Admins can still sign in when the directory or the network to it is down.

A directory account with the same username as a local account cannot sign in. It never takes over
or changes the local account; the refusal is logged. Keep at least one local admin with a strong
password, stored in the university's password safe.

## Security notes

- **Use TLS.** With plain `ldap://` and no StartTLS, passwords cross the network in clear text.
  The server logs a warning at startup when this is the case. Use `ldaps://` or `LDAP_STARTTLS=1`, and
  set `LDAP_TLS_CA` to the university CA certificate if it is not a public CA. The certificate and
  host name are always verified, and TLS 1.2 or newer is required. There is no switch to disable
  verification.
- **Least-privilege service account.** It only needs to search `LDAP_USER_BASE` and read the user
  filter attribute, the display name and the group attribute. It needs no write access and no
  access to password attributes. Use a dedicated account that cannot log in interactively, with a
  long random password kept in `.env` or a secret store (never in git).
- **Narrow the search.** Point `LDAP_USER_BASE` at the people OU, not the whole domain, and
  restrict the filter to person objects (and, in AD, enabled accounts). If the filter matches more
  than one entry, the sign-in is refused.
- **Prefer `LDAP_DEFAULT_ROLE=none`** in production, so only members of the mapped groups can
  sign in. Keep the admin group small.
- Every failed sign-in counts against the directory's account-lockout policy. The API does not
  rate-limit `/api/auth/login` yet, so someone could lock out a known username by guessing passwords
  repeatedly. Put a rate limit on the login route (`@fastify/rate-limit` is already a dependency)
  before opening the service beyond the campus LAN.
