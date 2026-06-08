// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0

//! Small serde helpers shared across service modules.
//!
//! ## `double_option`
//!
//! Lets a `PATCH` body distinguish three states for a nullable column:
//!
//! | JSON                | Rust value              | Meaning                |
//! |---------------------|-------------------------|------------------------|
//! | field absent        | `None`                  | leave the value alone  |
//! | `"field": null`     | `Some(None)`            | clear to NULL (inherit)|
//! | `"field": <value>`  | `Some(Some(value))`     | set an explicit value  |
//!
//! Use as:
//!
//! ```ignore
//! #[serde(default,
//!         deserialize_with = "crate::services::serde_helpers::double_option::deserialize")]
//! pub field: Option<Option<T>>,
//! ```
//!
//! Without this helper, serde collapses `null` and "absent" into a single
//! `None`, so the route handler can't tell "no change" from "clear".

pub mod double_option {
    use serde::{Deserialize, Deserializer};

    pub fn deserialize<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
    where
        T: Deserialize<'de>,
        D: Deserializer<'de>,
    {
        Option::<T>::deserialize(deserializer).map(Some)
    }
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::json;

    #[derive(Deserialize, Debug, PartialEq, Default)]
    struct Body {
        #[serde(default, deserialize_with = "super::double_option::deserialize")]
        field: Option<Option<bool>>,
    }

    #[test]
    fn absent_deserialises_to_outer_none() {
        let b: Body = serde_json::from_value(json!({})).unwrap();
        assert_eq!(b.field, None);
    }

    #[test]
    fn null_deserialises_to_some_none() {
        let b: Body = serde_json::from_value(json!({ "field": null })).unwrap();
        assert_eq!(b.field, Some(None));
    }

    #[test]
    fn value_deserialises_to_some_some() {
        let b: Body = serde_json::from_value(json!({ "field": true })).unwrap();
        assert_eq!(b.field, Some(Some(true)));
    }
}
