-- Projects, and who may do what inside one.
--
-- The hierarchy this exists to express:
--
--     project
--       ├── project_member        a user, with the role they hold *here*
--       ├── project_group         a team inside the project
--       │     └── project_group_member
--       ├── forms (forms.project_id)
--       │     └── form_assignment    who the form is for
--       └── submissions
--             └── submission_review  where each one has got to
--
-- A user's role is per project, not per account: the same person can manage one
-- project and enumerate in another. `app_user.role_id` stays what it always was
-- — what somebody may do *system-wide* (manage accounts, build forms at all) —
-- and `project_member.role_id` decides what they may do *in this project*.
--
-- Both point at `app_role`, so there is one role system and one permission
-- catalogue, not two. See app/modules/projects/access.py.

CREATE TABLE IF NOT EXISTS project (
    project_id  VARCHAR(20)  NOT NULL PRIMARY KEY,
    name        VARCHAR(200) NOT NULL,
    description TEXT         NOT NULL DEFAULT '',
    status      VARCHAR(20)  NOT NULL DEFAULT 'Active'
                CHECK (status IN ('Active', 'Archived')),
    created_on  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_on  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    created_by  VARCHAR(50)  NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_project_status ON project (status);

-- One row per person per project. The UNIQUE constraint is the rule that a
-- person is in a project once, holding one role there.
CREATE TABLE IF NOT EXISTS project_member (
    member_id  BIGSERIAL   PRIMARY KEY,
    project_id VARCHAR(20) NOT NULL REFERENCES project (project_id) ON DELETE CASCADE,
    user_id    VARCHAR(20) NOT NULL REFERENCES app_user (user_id) ON DELETE CASCADE,
    role_id    VARCHAR(20) NOT NULL REFERENCES app_role (role_id),
    status     VARCHAR(20) NOT NULL DEFAULT 'Active'
               CHECK (status IN ('Active', 'Suspended')),
    added_on   TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
    added_by   VARCHAR(50) NOT NULL DEFAULT '',
    UNIQUE (project_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_project_member_user ON project_member (user_id);
CREATE INDEX IF NOT EXISTS idx_project_member_project ON project_member (project_id);

-- A team inside one project. Groups never span projects: a form assigned to
-- "Field Team North" must mean one unambiguous set of people.
CREATE TABLE IF NOT EXISTS project_group (
    group_id    VARCHAR(20)  NOT NULL PRIMARY KEY,
    project_id  VARCHAR(20)  NOT NULL REFERENCES project (project_id) ON DELETE CASCADE,
    name        VARCHAR(200) NOT NULL,
    description TEXT         NOT NULL DEFAULT '',
    created_on  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    created_by  VARCHAR(50)  NOT NULL DEFAULT '',
    UNIQUE (project_id, name)
);

CREATE INDEX IF NOT EXISTS idx_project_group_project ON project_group (project_id);

CREATE TABLE IF NOT EXISTS project_group_member (
    group_id VARCHAR(20) NOT NULL REFERENCES project_group (group_id) ON DELETE CASCADE,
    user_id  VARCHAR(20) NOT NULL REFERENCES app_user (user_id) ON DELETE CASCADE,
    added_on TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_project_group_member_user ON project_group_member (user_id);

-- Who a form is for.
--
-- Three kinds, and the form is never copied — an assignment is a relationship:
--
--     everyone   anybody in the project
--     user       one named person
--     group      everybody in one project group
--
-- A form with no assignment at all is visible only to people whose project role
-- lets them see every form in the project. That is the safe default: a form
-- nobody was given is not a form everybody gets.
CREATE TABLE IF NOT EXISTS form_assignment (
    assignment_id BIGSERIAL   PRIMARY KEY,
    form_id       VARCHAR(20) NOT NULL REFERENCES forms (form_id) ON DELETE CASCADE,
    kind          VARCHAR(20) NOT NULL CHECK (kind IN ('everyone', 'user', 'group')),
    user_id       VARCHAR(20) REFERENCES app_user (user_id) ON DELETE CASCADE,
    group_id      VARCHAR(20) REFERENCES project_group (group_id) ON DELETE CASCADE,
    assigned_on   TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
    assigned_by   VARCHAR(50) NOT NULL DEFAULT '',

    -- The kind decides which column is filled. Anything else is a bug that
    -- would silently widen or narrow who can see a form.
    CHECK (
        (kind = 'everyone' AND user_id IS NULL AND group_id IS NULL)
     OR (kind = 'user'     AND user_id IS NOT NULL AND group_id IS NULL)
     OR (kind = 'group'    AND group_id IS NOT NULL AND user_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_form_assignment_form ON form_assignment (form_id);

-- One assignment of each kind per target: assigning the same person twice is
-- not a stronger assignment, it is a duplicate row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_form_assignment_everyone
    ON form_assignment (form_id) WHERE kind = 'everyone';
CREATE UNIQUE INDEX IF NOT EXISTS uq_form_assignment_user
    ON form_assignment (form_id, user_id) WHERE kind = 'user';
CREATE UNIQUE INDEX IF NOT EXISTS uq_form_assignment_group
    ON form_assignment (form_id, group_id) WHERE kind = 'group';

-- Where one submission has got to.
--
-- Deliberately a table beside the responses rather than columns on them. Every
-- form has its own dynamically created table; putting workflow columns in that
-- envelope would mean migrating each one and rebuilding its flat mirror. This
-- keeps the answers exactly as they are and records the review next to them.
CREATE TABLE IF NOT EXISTS submission_review (
    form_id          VARCHAR(20) NOT NULL REFERENCES forms (form_id) ON DELETE CASCADE,
    survey_id        VARCHAR(50) NOT NULL,
    status           VARCHAR(20) NOT NULL DEFAULT 'submitted'
                     CHECK (status IN ('draft', 'submitted', 'under_review',
                                       'approved', 'rejected')),
    submitted_by     VARCHAR(50) NOT NULL DEFAULT '',
    submitted_on     TIMESTAMP,
    reviewed_by      VARCHAR(50) NOT NULL DEFAULT '',
    reviewed_on      TIMESTAMP,
    rejection_reason TEXT        NOT NULL DEFAULT '',
    updated_on       TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (form_id, survey_id)
);

CREATE INDEX IF NOT EXISTS idx_submission_review_status
    ON submission_review (form_id, status);
