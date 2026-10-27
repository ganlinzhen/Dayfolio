// 命令输入契约来自现有 TypeScript 业务接口；保持为静态数据，不在运行时加载编译器。
export const COMMAND_INPUTS: Record<string,unknown[]> = {
  "add_todo": [
    {
      "type": "object",
      "properties": {
        "title": {
          "type": "string"
        },
        "notes": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "priority": {
          "enum": [
            "high",
            "medium",
            "low"
          ]
        },
        "due_date": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "string"
            }
          ]
        },
        "start_time": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "string"
            }
          ]
        },
        "end_time": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "string"
            }
          ]
        },
        "end_date": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "string"
            }
          ]
        },
        "time_mode": {
          "enum": [
            "floating",
            "instant"
          ]
        },
        "scheduled_start_at": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "string"
            }
          ]
        },
        "scheduled_end_at": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "string"
            }
          ]
        },
        "collection_id": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "string"
            }
          ]
        },
        "tags": {
          "anyOf": [
            {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          ]
        },
        "source": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        }
      },
      "required": [
        "title"
      ],
      "additionalProperties": false
    }
  ],
  "update_todo": [
    {
      "type": "number"
    },
    {
      "type": "object",
      "properties": {
        "title": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "notes": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "string"
            }
          ]
        },
        "priority": {
          "enum": [
            "high",
            "medium",
            "low"
          ]
        },
        "due_date": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "string"
            }
          ]
        },
        "start_time": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "string"
            }
          ]
        },
        "end_time": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "string"
            }
          ]
        },
        "end_date": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "string"
            }
          ]
        },
        "time_mode": {
          "enum": [
            "floating",
            "instant"
          ]
        },
        "scheduled_start_at": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "string"
            }
          ]
        },
        "scheduled_end_at": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "string"
            }
          ]
        },
        "collection_id": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "string"
            }
          ]
        },
        "expected_revision": {
          "anyOf": [
            {
              "type": "number"
            }
          ]
        },
        "tags": {
          "anyOf": [
            {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          ]
        },
        "status": {
          "enum": [
            "open",
            "done"
          ]
        }
      },
      "required": [],
      "additionalProperties": false
    }
  ],
  "complete_todo": [
    {
      "type": "number"
    },
    {
      "enum": [
        false,
        true
      ]
    }
  ],
  "reopen_todo": [
    {
      "type": "number"
    }
  ],
  "delete_todo": [
    {
      "type": "number"
    }
  ],
  "create_study_plan": [
    {
      "type": "object",
      "properties": {
        "title": {
          "type": "string"
        },
        "goal": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "start_date": {
          "type": "string"
        },
        "end_date": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "notes": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "date": {
                "type": "string"
              },
              "content": {
                "type": "string"
              },
              "item_type": {
                "enum": [
                  "learn",
                  "review",
                  "practice",
                  "rest"
                ]
              },
              "duration_min": {
                "anyOf": [
                  {
                    "type": "null"
                  },
                  {
                    "type": "number"
                  }
                ]
              },
              "knowledge_key": {
                "anyOf": [
                  {
                    "type": "null"
                  },
                  {
                    "type": "string"
                  }
                ]
              }
            },
            "required": [
              "date",
              "content"
            ],
            "additionalProperties": false
          }
        },
        "create_todos": {
          "enum": [
            false,
            true
          ]
        },
        "daily_minutes": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "number"
            }
          ]
        }
      },
      "required": [
        "title",
        "start_date",
        "items"
      ],
      "additionalProperties": false
    }
  ],
  "update_study_plan": [
    {
      "type": "number"
    },
    {
      "type": "object",
      "properties": {
        "title": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "goal": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "notes": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "status": {
          "enum": [
            "done",
            "active",
            "archived"
          ]
        }
      },
      "required": [],
      "additionalProperties": false
    }
  ],
  "update_plan_item": [
    {
      "type": "number"
    },
    {
      "enum": [
        "done",
        "pending",
        "skipped"
      ]
    }
  ],
  "delete_study_plan": [
    {
      "type": "number"
    },
    {
      "type": "object",
      "properties": {
        "delete_todos": {
          "enum": [
            false,
            true
          ]
        }
      },
      "required": [],
      "additionalProperties": false
    }
  ],
  "checkin": [
    {
      "type": "object",
      "properties": {
        "ref_type": {
          "enum": [
            "todo",
            "plan_item",
            "day"
          ]
        },
        "ref_id": {
          "anyOf": [
            {
              "type": "number"
            }
          ]
        },
        "date": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "note": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        }
      },
      "required": [
        "ref_type"
      ],
      "additionalProperties": false
    }
  ],
  "remove_checkin": [
    {
      "enum": [
        "todo",
        "plan_item",
        "day"
      ]
    },
    {
      "type": "number"
    },
    {
      "type": "string"
    }
  ],
  "create_review_schedule": [
    {
      "type": "object",
      "properties": {
        "title": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "topics": {
          "type": "array",
          "items": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "object",
                "properties": {
                  "name": {
                    "type": "string"
                  },
                  "learned_date": {
                    "anyOf": [
                      {
                        "type": "string"
                      }
                    ]
                  }
                },
                "required": [
                  "name"
                ],
                "additionalProperties": false
              }
            ]
          }
        },
        "start_date": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "intervals": {
          "anyOf": [
            {
              "type": "array",
              "items": {
                "type": "number"
              }
            }
          ]
        },
        "duration_min": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "number"
            }
          ]
        },
        "create_todos": {
          "enum": [
            false,
            true
          ]
        }
      },
      "required": [
        "topics"
      ],
      "additionalProperties": false
    }
  ],
  "draft_study_plan": [
    {
      "type": "object",
      "properties": {
        "title": {
          "type": "string"
        },
        "goal": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "material_source": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "daily_minutes": {
          "type": "number"
        },
        "start_date": {
          "type": "string"
        },
        "knowledge_points": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "key": {
                "type": "string"
              },
              "name": {
                "type": "string"
              },
              "depends_on": {
                "anyOf": [
                  {
                    "type": "array",
                    "items": {
                      "type": "string"
                    }
                  }
                ]
              },
              "est_minutes": {
                "anyOf": [
                  {
                    "type": "number"
                  }
                ]
              },
              "outcome": {
                "anyOf": [
                  {
                    "type": "string"
                  }
                ]
              }
            },
            "required": [
              "key",
              "name"
            ],
            "additionalProperties": false
          }
        },
        "notes": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        }
      },
      "required": [
        "title",
        "daily_minutes",
        "start_date",
        "knowledge_points"
      ],
      "additionalProperties": false
    }
  ],
  "draft_study_topic": [
    {
      "type": "object",
      "properties": {
        "title": {
          "type": "string"
        },
        "goal": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "material_source": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "knowledge_points": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "key": {
                "type": "string"
              },
              "name": {
                "type": "string"
              },
              "depends_on": {
                "anyOf": [
                  {
                    "type": "array",
                    "items": {
                      "type": "string"
                    }
                  }
                ]
              },
              "est_minutes": {
                "anyOf": [
                  {
                    "type": "number"
                  }
                ]
              },
              "outcome": {
                "anyOf": [
                  {
                    "type": "string"
                  }
                ]
              }
            },
            "required": [
              "key",
              "name"
            ],
            "additionalProperties": false
          }
        },
        "course_id": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "number"
            }
          ]
        },
        "notes": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        }
      },
      "required": [
        "title",
        "knowledge_points"
      ],
      "additionalProperties": false
    }
  ],
  "update_study_topic_draft": [
    {
      "type": "number"
    },
    {
      "type": "object",
      "properties": {
        "title": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "goal": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "string"
            }
          ]
        },
        "material_source": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "string"
            }
          ]
        },
        "knowledge_points": {
          "anyOf": [
            {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "key": {
                    "type": "string"
                  },
                  "name": {
                    "type": "string"
                  },
                  "depends_on": {
                    "anyOf": [
                      {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      }
                    ]
                  },
                  "est_minutes": {
                    "anyOf": [
                      {
                        "type": "number"
                      }
                    ]
                  },
                  "outcome": {
                    "anyOf": [
                      {
                        "type": "string"
                      }
                    ]
                  }
                },
                "required": [
                  "key",
                  "name"
                ],
                "additionalProperties": false
              }
            }
          ]
        },
        "course_id": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "number"
            }
          ]
        },
        "notes": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "string"
            }
          ]
        }
      },
      "required": [],
      "additionalProperties": false
    }
  ],
  "schedule_study_draft": [
    {
      "type": "number"
    },
    {
      "type": "string"
    },
    {
      "type": "number"
    },
    {
      "type": "object",
      "properties": {
        "confirmed_over_dates": {
          "anyOf": [
            {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          ]
        }
      },
      "required": [],
      "additionalProperties": false
    }
  ],
  "confirm_study_plan_draft": [
    {
      "type": "number"
    },
    {
      "type": "object",
      "properties": {
        "confirmed_over_dates": {
          "anyOf": [
            {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          ]
        }
      },
      "required": [],
      "additionalProperties": false
    }
  ],
  "cancel_study_plan_draft": [
    {
      "type": "number"
    }
  ],
  "record_study_session": [
    {
      "type": "object",
      "properties": {
        "id": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "plan_id": {
          "anyOf": [
            {
              "type": "number"
            }
          ]
        },
        "plan_item_id": {
          "anyOf": [
            {
              "type": "number"
            }
          ]
        },
        "knowledge_key": {
          "type": "string"
        },
        "topic": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "attempt": {
          "anyOf": [
            {
              "type": "number"
            }
          ]
        },
        "date": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "actual_minutes": {
          "anyOf": [
            {
              "type": "number"
            }
          ]
        },
        "explanation": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "questions": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "material_source": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        }
      },
      "required": [
        "knowledge_key"
      ],
      "additionalProperties": false
    }
  ],
  "record_study_assessment": [
    {
      "type": "object",
      "properties": {
        "id": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "session_id": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "plan_id": {
          "anyOf": [
            {
              "type": "number"
            }
          ]
        },
        "plan_item_id": {
          "anyOf": [
            {
              "type": "number"
            }
          ]
        },
        "knowledge_key": {
          "type": "string"
        },
        "topic": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "question": {
          "type": "string"
        },
        "criteria": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "answer": {
          "type": "string"
        },
        "source": {
          "enum": [
            "self",
            "objective",
            "ai_suggestion"
          ]
        },
        "score": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "number"
            }
          ]
        },
        "objective_passed": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "boolean"
            },
            {
              "type": "boolean"
            }
          ]
        },
        "feedback": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "evidence": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "date": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        }
      },
      "required": [
        "knowledge_key",
        "question",
        "answer",
        "source"
      ],
      "additionalProperties": false
    }
  ],
  "apply_plan_adjustments": [
    {
      "type": "number"
    },
    {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "to_date": {
            "type": "string"
          }
        },
        "required": [
          "id",
          "to_date"
        ],
        "additionalProperties": false
      }
    }
  ],
  "export_study_cards": [
    {
      "type": "object",
      "properties": {
        "plan_id": {
          "anyOf": [
            {
              "type": "number"
            }
          ]
        },
        "knowledge_keys": {
          "anyOf": [
            {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          ]
        },
        "session_ids": {
          "anyOf": [
            {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          ]
        }
      },
      "required": [],
      "additionalProperties": false
    },
    {
      "type": "string"
    }
  ],
  "create_news_task": [
    {
      "type": "object",
      "properties": {
        "title": {
          "type": "string"
        },
        "instructions": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "max_items": {
          "anyOf": [
            {
              "type": "number"
            }
          ]
        },
        "window_hours": {
          "anyOf": [
            {
              "type": "number"
            }
          ]
        },
        "use_collection_prompt": {
          "enum": [
            false,
            true
          ]
        }
      },
      "required": [
        "title"
      ],
      "additionalProperties": false
    },
    {
      "type": "string"
    }
  ],
  "claim_news_task": [
    {
      "anyOf": [
        {
          "type": "number"
        }
      ]
    },
    {
      "type": "string"
    }
  ],
  "submit_news_items": [
    {
      "type": "number"
    },
    {
      "type": "string"
    },
    {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "candidate_topic": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "key": {
                    "type": "string"
                  },
                  "name": {
                    "type": "string"
                  },
                  "scope": {
                    "type": "string"
                  },
                  "reason": {
                    "type": "string"
                  },
                  "basis_news_ids": {
                    "type": "array",
                    "items": {
                      "type": "number"
                    }
                  },
                  "basis_module_id": {
                    "anyOf": [
                      {
                        "type": "string"
                      }
                    ]
                  }
                },
                "required": [
                  "key",
                  "name",
                  "scope",
                  "reason",
                  "basis_news_ids"
                ],
                "additionalProperties": false
              }
            ]
          },
          "brief": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "overview": {
                    "type": "string"
                  },
                  "items": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "title": {
                          "type": "string"
                        },
                        "summary": {
                          "type": "string"
                        },
                        "source_url": {
                          "type": "string"
                        },
                        "source_name": {
                          "anyOf": [
                            {
                              "type": "string"
                            }
                          ]
                        },
                        "published_at": {
                          "type": "string"
                        }
                      },
                      "required": [
                        "title",
                        "summary",
                        "source_url",
                        "published_at"
                      ],
                      "additionalProperties": false
                    }
                  }
                },
                "required": [
                  "overview",
                  "items"
                ],
                "additionalProperties": false
              }
            ]
          },
          "title": {
            "type": "string"
          },
          "summary": {
            "type": "string"
          },
          "source_url": {
            "type": "string"
          },
          "source_name": {
            "anyOf": [
              {
                "type": "string"
              }
            ]
          },
          "published_at": {
            "type": "string"
          },
          "html": {
            "anyOf": [
              {
                "type": "string"
              }
            ]
          },
          "module_id": {
            "anyOf": [
              {
                "type": "null"
              },
              {
                "type": "string"
              }
            ]
          },
          "event_id": {
            "anyOf": [
              {
                "type": "null"
              },
              {
                "type": "string"
              }
            ]
          },
          "topic_keys": {
            "anyOf": [
              {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            ]
          },
          "image_url": {
            "anyOf": [
              {
                "type": "null"
              },
              {
                "type": "string"
              }
            ]
          },
          "image_source_url": {
            "anyOf": [
              {
                "type": "null"
              },
              {
                "type": "string"
              }
            ]
          },
          "image_caption": {
            "anyOf": [
              {
                "type": "null"
              },
              {
                "type": "string"
              }
            ]
          },
          "background": {
            "anyOf": [
              {
                "type": "null"
              },
              {
                "type": "string"
              }
            ]
          },
          "impact": {
            "anyOf": [
              {
                "type": "null"
              },
              {
                "type": "string"
              }
            ]
          },
          "uncertainty": {
            "anyOf": [
              {
                "type": "null"
              },
              {
                "type": "string"
              }
            ]
          }
        },
        "required": [
          "title",
          "summary",
          "source_url",
          "published_at"
        ],
        "additionalProperties": false
      }
    }
  ],
  "complete_news_task": [
    {
      "type": "number"
    },
    {
      "type": "string"
    },
    {
      "anyOf": [
        {
          "type": "string"
        }
      ]
    }
  ],
  "release_news_task": [
    {
      "type": "number"
    },
    {
      "type": "string"
    },
    {
      "anyOf": [
        {
          "type": "string"
        }
      ]
    }
  ],
  "cancel_news_task": [
    {
      "type": "number"
    }
  ],
  "mark_news_read": [
    {
      "type": "number"
    },
    {
      "enum": [
        false,
        true
      ]
    }
  ],
  "mark_news_starred": [
    {
      "type": "number"
    },
    {
      "enum": [
        false,
        true
      ]
    }
  ],
  "mark_all_news_read": [
    {
      "type": "object",
      "properties": {
        "task_id": {
          "anyOf": [
            {
              "type": "number"
            }
          ]
        },
        "source": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        }
      },
      "required": [],
      "additionalProperties": false
    }
  ],
  "delete_news_item": [
    {
      "type": "number"
    }
  ],
  "enqueue_news_agent_run": [
    {
      "anyOf": [
        {
          "type": "number"
        }
      ]
    }
  ],
  "cancel_news_agent_run": [
    {
      "type": "string"
    }
  ],
  "claim_news_agent_run": [
    {
      "type": "string"
    },
    {
      "type": "number"
    }
  ],
  "update_news_agent_run": [
    {
      "type": "string"
    },
    {
      "type": "string"
    },
    {
      "type": "string"
    },
    {
      "anyOf": [
        {
          "type": "string"
        }
      ]
    }
  ],
  "finish_news_agent_run": [
    {
      "type": "string"
    },
    {
      "type": "string"
    },
    {
      "enum": [
        "cancelled",
        "succeeded",
        "failed",
        "interrupted"
      ]
    },
    {
      "anyOf": [
        {
          "type": "string"
        }
      ]
    }
  ],
  "recover_news_agent_run": [
    {
      "type": "string"
    }
  ],
  "update_news_collection_settings": [
    {
      "type": "object",
      "properties": {
        "prompt": {
          "type": "string"
        },
        "max_items": {
          "type": "number"
        },
        "window_hours": {
          "type": "number"
        },
        "expected_revision": {
          "type": "number"
        }
      },
      "required": [
        "prompt",
        "max_items",
        "window_hours",
        "expected_revision"
      ],
      "additionalProperties": false
    }
  ],
  "update_news_feed_config": [
    {
      "type": "object",
      "properties": {
        "config": {
          "type": "object",
          "properties": {
            "revision": {
              "type": "number"
            },
            "updated_at": {
              "anyOf": [
                {
                  "type": "null"
                },
                {
                  "type": "string"
                }
              ]
            },
            "modules": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string"
                  },
                  "name": {
                    "type": "string"
                  },
                  "enabled": {
                    "enum": [
                      false,
                      true
                    ]
                  },
                  "kind": {
                    "enum": [
                      "public",
                      "topic",
                      "events"
                    ]
                  },
                  "scope": {
                    "type": "string"
                  },
                  "exclusions": {
                    "type": "string"
                  },
                  "window_hours": {
                    "type": "number"
                  },
                  "headline_count": {
                    "type": "number"
                  },
                  "max_items": {
                    "type": "number"
                  },
                  "content": {
                    "type": "object",
                    "properties": {
                      "summary_depth": {
                        "enum": [
                          "brief",
                          "standard",
                          "deep"
                        ]
                      },
                      "image_policy": {
                        "enum": [
                          "prefer_original",
                          "none"
                        ]
                      },
                      "image_display": {
                        "enum": [
                          "list_thumbnail",
                          "detail_only"
                        ]
                      },
                      "show_background": {
                        "enum": [
                          false,
                          true
                        ]
                      },
                      "show_impact": {
                        "enum": [
                          false,
                          true
                        ]
                      },
                      "show_uncertainty": {
                        "enum": [
                          false,
                          true
                        ]
                      }
                    },
                    "required": [],
                    "additionalProperties": false
                  },
                  "source_preferences": {
                    "anyOf": [
                      {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      }
                    ]
                  },
                  "source_exclusions": {
                    "anyOf": [
                      {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      }
                    ]
                  },
                  "extra_instructions": {
                    "anyOf": [
                      {
                        "type": "string"
                      }
                    ]
                  }
                },
                "required": [
                  "id",
                  "name",
                  "enabled",
                  "kind",
                  "scope",
                  "exclusions",
                  "window_hours",
                  "headline_count",
                  "max_items",
                  "content"
                ],
                "additionalProperties": false
              }
            },
            "content": {
              "type": "object",
              "properties": {
                "summary_depth": {
                  "enum": [
                    "brief",
                    "standard",
                    "deep"
                  ]
                },
                "image_policy": {
                  "enum": [
                    "prefer_original",
                    "none"
                  ]
                },
                "image_display": {
                  "enum": [
                    "list_thumbnail",
                    "detail_only"
                  ]
                },
                "show_background": {
                  "enum": [
                    false,
                    true
                  ]
                },
                "show_impact": {
                  "enum": [
                    false,
                    true
                  ]
                },
                "show_uncertainty": {
                  "enum": [
                    false,
                    true
                  ]
                }
              },
              "required": [
                "summary_depth",
                "image_policy",
                "show_background",
                "show_impact",
                "show_uncertainty"
              ],
              "additionalProperties": false
            },
            "schedule": {
              "type": "object",
              "properties": {
                "enabled": {
                  "enum": [
                    false,
                    true
                  ]
                },
                "timezone": {
                  "const": "Asia/Shanghai"
                },
                "times": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                }
              },
              "required": [
                "enabled",
                "timezone",
                "times"
              ],
              "additionalProperties": false
            },
            "learning": {
              "type": "object",
              "properties": {
                "enabled": {
                  "enum": [
                    false,
                    true
                  ]
                },
                "exploration_enabled": {
                  "enum": [
                    false,
                    true
                  ]
                }
              },
              "required": [
                "enabled",
                "exploration_enabled"
              ],
              "additionalProperties": false
            },
            "budget_minutes": {
              "type": "number"
            }
          },
          "required": [
            "revision",
            "updated_at",
            "modules",
            "content",
            "schedule",
            "learning",
            "budget_minutes"
          ],
          "additionalProperties": false
        },
        "expected_revision": {
          "type": "number"
        }
      },
      "required": [
        "config",
        "expected_revision"
      ],
      "additionalProperties": false
    }
  ],
  "start_news_feed_update": [
    {
      "type": "object",
      "properties": {
        "trigger": {
          "enum": [
            "manual",
            "scheduled"
          ]
        },
        "slot_key": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        }
      },
      "required": [],
      "additionalProperties": false
    }
  ],
  "advance_news_feed_update": [
    {
      "anyOf": [
        {
          "type": "string"
        }
      ]
    }
  ],
  "stop_news_feed_update": [
    {
      "type": "string"
    }
  ],
  "continue_news_feed_update": [
    {
      "type": "object",
      "properties": {
        "batch_id": {
          "type": "string"
        }
      },
      "required": [
        "batch_id"
      ],
      "additionalProperties": false
    }
  ],
  "record_news_feedback": [
    {
      "type": "object",
      "properties": {
        "news_id": {
          "type": "number"
        },
        "kind": {
          "enum": [
            "open",
            "read",
            "source_open",
            "star",
            "unstar",
            "interested",
            "less_topic",
            "less_source",
            "hide",
            "undo_hide"
          ]
        },
        "source": {
          "enum": [
            "app",
            "explicit"
          ]
        },
        "idempotency_key": {
          "type": "string"
        },
        "topic_key": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "reading_seconds": {
          "anyOf": [
            {
              "type": "number"
            }
          ]
        }
      },
      "required": [
        "news_id",
        "kind",
        "source",
        "idempotency_key"
      ],
      "additionalProperties": false
    }
  ],
  "manage_news_topic": [
    {
      "type": "object",
      "properties": {
        "key": {
          "type": "string"
        },
        "name": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "action": {
          "enum": [
            "follow",
            "unfollow",
            "reduce",
            "remove",
            "restore"
          ]
        }
      },
      "required": [
        "key",
        "action"
      ],
      "additionalProperties": false
    }
  ],
  "manage_news_source": [
    {
      "type": "object",
      "properties": {
        "source_name": {
          "type": "string"
        },
        "action": {
          "enum": [
            "reduce",
            "restore"
          ]
        }
      },
      "required": [
        "source_name",
        "action"
      ],
      "additionalProperties": false
    }
  ],
  "reset_news_learning": [],
  "update_news_event": [
    {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "name": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "scope": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "status": {
          "enum": [
            "active",
            "paused",
            "ended"
          ]
        },
        "expires_at": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "string"
            }
          ]
        },
        "expected_revision": {
          "type": "number"
        }
      },
      "required": [
        "id",
        "expected_revision"
      ],
      "additionalProperties": false
    }
  ],
  "dismiss_news_event_reminder": [
    {
      "type": "string"
    }
  ],
  "import_news_starred_interests": [
    {
      "type": "object",
      "properties": {
        "news_ids": {
          "anyOf": [
            {
              "type": "array",
              "items": {
                "type": "number"
              }
            }
          ]
        }
      },
      "required": [],
      "additionalProperties": false
    }
  ],
  "report_news_correction": [
    {
      "type": "object",
      "properties": {
        "news_id": {
          "type": "number"
        },
        "summary": {
          "type": "string"
        },
        "evidence_url": {
          "type": "string"
        }
      },
      "required": [
        "news_id",
        "summary",
        "evidence_url"
      ],
      "additionalProperties": false
    }
  ],
  "dismiss_news_correction": [
    {
      "type": "string"
    }
  ],
  "update_agent_settings": [
    {
      "type": "object",
      "properties": {
        "provider": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "const": "codex"
            },
            {
              "const": "claude"
            },
            {
              "const": "gemini"
            }
          ]
        },
        "binary": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "model": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "expected_revision": {
          "type": "number"
        }
      },
      "required": [
        "provider",
        "expected_revision"
      ],
      "additionalProperties": false
    }
  ],
  "import_course": [
    {
      "type": "string"
    }
  ],
  "delete_course": [
    {
      "type": "number"
    },
    {
      "type": "string"
    }
  ],
  "mark_lesson_read": [
    {
      "type": "number"
    },
    {
      "type": "number"
    }
  ],
  "submit_lesson_quiz": [
    {
      "type": "number"
    },
    {
      "type": "number"
    },
    {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "question_id": {
            "type": "string"
          },
          "picked": {
            "type": "number"
          }
        },
        "required": [
          "question_id",
          "picked"
        ],
        "additionalProperties": false
      }
    }
  ],
  "confirm_course_sample": [
    {
      "type": "number"
    },
    {
      "anyOf": [
        {
          "type": "string"
        }
      ]
    }
  ],
  "create_course_request": [
    {
      "type": "number"
    },
    {
      "type": "string"
    }
  ],
  "claim_course_request": [
    {
      "type": "number"
    },
    {
      "type": "string"
    }
  ],
  "complete_course_request": [
    {
      "type": "number"
    },
    {
      "type": "string"
    }
  ],
  "add_tool": [
    {
      "type": "object",
      "properties": {
        "files": {
          "anyOf": [
            {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "name": {
                    "type": "string"
                  },
                  "contentBase64": {
                    "type": "string"
                  }
                },
                "required": [
                  "name",
                  "contentBase64"
                ],
                "additionalProperties": false
              }
            }
          ]
        },
        "title": {
          "type": "string"
        },
        "icon": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "icon_background": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "category_id": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "number"
            }
          ]
        },
        "entry_file": {
          "type": "string"
        }
      },
      "required": [
        "title",
        "entry_file"
      ],
      "additionalProperties": false
    }
  ],
  "update_tool": [
    {
      "type": "number"
    },
    {
      "type": "object",
      "properties": {
        "files": {
          "anyOf": [
            {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "name": {
                    "type": "string"
                  },
                  "contentBase64": {
                    "type": "string"
                  }
                },
                "required": [
                  "name",
                  "contentBase64"
                ],
                "additionalProperties": false
              }
            }
          ]
        },
        "title": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "icon": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "icon_background": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "category_id": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "number"
            }
          ]
        },
        "entry_file": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        }
      },
      "required": [],
      "additionalProperties": false
    }
  ],
  "delete_tool": [
    {
      "type": "number"
    }
  ],
  "reorder_tools": [
    {
      "type": "array",
      "items": {
        "type": "number"
      }
    }
  ],
  "add_tool_category": [
    {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        }
      },
      "required": [
        "name"
      ],
      "additionalProperties": false
    }
  ],
  "rename_tool_category": [
    {
      "type": "number"
    },
    {
      "type": "string"
    }
  ],
  "delete_tool_category": [
    {
      "type": "number"
    }
  ],
  "reorder_tool_categories": [
    {
      "type": "array",
      "items": {
        "type": "number"
      }
    }
  ],
  "register_vault": [
    {
      "type": "object",
      "properties": {
        "root_path": {
          "type": "string"
        },
        "name": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "include_dirs": {
          "anyOf": [
            {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          ]
        },
        "include_raw": {
          "enum": [
            false,
            true
          ]
        }
      },
      "required": [
        "root_path"
      ],
      "additionalProperties": false
    }
  ],
  "update_vault": [
    {
      "type": "number"
    },
    {
      "type": "object",
      "properties": {
        "name": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "include_dirs": {
          "anyOf": [
            {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          ]
        },
        "include_raw": {
          "enum": [
            false,
            true
          ]
        }
      },
      "required": [],
      "additionalProperties": false
    }
  ],
  "remove_vault": [
    {
      "type": "number"
    }
  ],
  "scan_vault": [
    {
      "type": "number"
    }
  ],
  "link_concept_note": [
    {
      "type": "object",
      "properties": {
        "vault_id": {
          "type": "number"
        },
        "rel_path": {
          "type": "string"
        },
        "knowledge_key": {
          "type": "string"
        }
      },
      "required": [
        "vault_id",
        "rel_path",
        "knowledge_key"
      ],
      "additionalProperties": false
    }
  ],
  "unlink_concept_note": [
    {
      "type": "number"
    }
  ],
  "add_media_topic": [
    {
      "type": "object",
      "properties": {
        "title": {
          "type": "string"
        },
        "angle": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "source": {
          "enum": [
            "manual",
            "news",
            "knowledge"
          ]
        },
        "source_news_id": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "number"
            }
          ]
        },
        "source_note": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "string"
            },
            {
              "type": "object",
              "properties": {
                "vault_id": {
                  "type": "number"
                },
                "rel_path": {
                  "type": "string"
                }
              },
              "required": [
                "vault_id",
                "rel_path"
              ],
              "additionalProperties": false
            }
          ]
        },
        "source_desc": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "tags": {
          "anyOf": [
            {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          ]
        }
      },
      "required": [
        "title"
      ],
      "additionalProperties": false
    }
  ],
  "update_media_topic": [
    {
      "type": "number"
    },
    {
      "type": "object",
      "properties": {
        "title": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "angle": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "string"
            }
          ]
        },
        "status": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "tags": {
          "anyOf": [
            {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          ]
        }
      },
      "required": [],
      "additionalProperties": false
    }
  ],
  "delete_media_topic": [
    {
      "type": "number"
    }
  ],
  "add_media_content": [
    {
      "type": "object",
      "properties": {
        "topic_id": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "number"
            }
          ]
        },
        "title": {
          "type": "string"
        },
        "master_content": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        }
      },
      "required": [
        "title"
      ],
      "additionalProperties": false
    }
  ],
  "update_media_content": [
    {
      "type": "number"
    },
    {
      "type": "object",
      "properties": {
        "title": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "master_content": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "status": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "retro_note": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        }
      },
      "required": [],
      "additionalProperties": false
    }
  ],
  "delete_media_content": [
    {
      "type": "number"
    }
  ],
  "add_media_material": [
    {
      "type": "object",
      "properties": {
        "title": {
          "type": "string"
        },
        "kind": {
          "enum": [
            "text",
            "image",
            "link",
            "note"
          ]
        },
        "content": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "source": {
          "enum": [
            "manual",
            "news",
            "knowledge"
          ]
        },
        "source_news_id": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "number"
            }
          ]
        },
        "source_note": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "string"
            },
            {
              "type": "object",
              "properties": {
                "vault_id": {
                  "type": "number"
                },
                "rel_path": {
                  "type": "string"
                }
              },
              "required": [
                "vault_id",
                "rel_path"
              ],
              "additionalProperties": false
            }
          ]
        },
        "source_desc": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "tags": {
          "anyOf": [
            {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          ]
        }
      },
      "required": [
        "title"
      ],
      "additionalProperties": false
    }
  ],
  "update_media_material": [
    {
      "type": "number"
    },
    {
      "type": "object",
      "properties": {
        "title": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "kind": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "content": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "tags": {
          "anyOf": [
            {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          ]
        }
      },
      "required": [],
      "additionalProperties": false
    }
  ],
  "delete_media_material": [
    {
      "type": "number"
    }
  ],
  "add_media_version": [
    {
      "type": "number"
    },
    {
      "type": "object",
      "properties": {
        "platform": {
          "type": "string"
        },
        "body": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        }
      },
      "required": [
        "platform"
      ],
      "additionalProperties": false
    }
  ],
  "update_media_version": [
    {
      "type": "number"
    },
    {
      "type": "object",
      "properties": {
        "body": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        }
      },
      "required": [],
      "additionalProperties": false
    }
  ],
  "review_media_version": [
    {
      "type": "number"
    },
    {
      "enum": [
        "submit",
        "approve",
        "reject",
        "revoke"
      ]
    },
    {
      "anyOf": [
        {
          "type": "string"
        }
      ]
    }
  ],
  "submit_media_version": [
    {
      "type": "number"
    },
    {
      "enum": [
        "submit",
        "approve",
        "reject",
        "revoke"
      ]
    },
    {
      "anyOf": [
        {
          "type": "string"
        }
      ]
    }
  ],
  "attach_media_material": [
    {
      "type": "number"
    },
    {
      "type": "number"
    }
  ],
  "detach_media_material": [
    {
      "type": "number"
    },
    {
      "type": "number"
    }
  ],
  "schedule_media_post": [
    {
      "type": "object",
      "properties": {
        "content_version_id": {
          "type": "number"
        },
        "planned_date": {
          "type": "string"
        },
        "note": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        }
      },
      "required": [
        "content_version_id",
        "planned_date"
      ],
      "additionalProperties": false
    }
  ],
  "mark_media_published": [
    {
      "type": "number"
    },
    {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "published_at": {
              "anyOf": [
                {
                  "type": "string"
                }
              ]
            },
            "publish_url": {
              "anyOf": [
                {
                  "type": "null"
                },
                {
                  "type": "string"
                }
              ]
            },
            "note": {
              "anyOf": [
                {
                  "type": "string"
                }
              ]
            }
          },
          "required": [],
          "additionalProperties": false
        }
      ]
    }
  ],
  "cancel_media_schedule": [
    {
      "type": "number"
    }
  ],
  "add_media_metric": [
    {
      "type": "object",
      "properties": {
        "calendar_id": {
          "type": "number"
        },
        "date": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "views": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "number"
            }
          ]
        },
        "likes": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "number"
            }
          ]
        },
        "comments": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "number"
            }
          ]
        },
        "shares": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "number"
            }
          ]
        },
        "favorites": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "number"
            }
          ]
        },
        "custom": {
          "anyOf": [
            {
              "type": "object",
              "properties": {},
              "required": [],
              "additionalProperties": {
                "type": "number"
              }
            }
          ]
        },
        "note": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        }
      },
      "required": [
        "calendar_id"
      ],
      "additionalProperties": false
    }
  ],
  "export_media_package": [
    {
      "type": "number"
    },
    {
      "type": "string"
    }
  ],
  "add_calendar_event": [
    {
      "type": "object",
      "properties": {
        "title": {
          "type": "string"
        },
        "date": {
          "type": "string"
        },
        "end_date": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "string"
            }
          ]
        },
        "start_time": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "string"
            }
          ]
        },
        "end_time": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "string"
            }
          ]
        },
        "note": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "color": {
          "enum": [
            "blue",
            "green",
            "violet",
            "amber",
            "rose",
            "slate"
          ]
        },
        "source": {
          "enum": [
            "mcp",
            "app"
          ]
        }
      },
      "required": [
        "title",
        "date"
      ],
      "additionalProperties": false
    }
  ],
  "update_calendar_event": [
    {
      "type": "number"
    },
    {
      "type": "object",
      "properties": {
        "title": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "date": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "end_date": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "string"
            }
          ]
        },
        "start_time": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "string"
            }
          ]
        },
        "end_time": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "string"
            }
          ]
        },
        "note": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "color": {
          "enum": [
            "blue",
            "green",
            "violet",
            "amber",
            "rose",
            "slate"
          ]
        },
        "source": {
          "enum": [
            "mcp",
            "app"
          ]
        }
      },
      "required": [],
      "additionalProperties": false
    }
  ],
  "delete_calendar_event": [
    {
      "type": "number"
    }
  ],
  "add_tool_todos": [
    {
      "type": "object",
      "properties": {
        "toolId": {
          "type": "number"
        },
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "sourceKey": {
                "type": "string"
              },
              "title": {
                "type": "string"
              },
              "notes": {
                "anyOf": [
                  {
                    "type": "string"
                  }
                ]
              },
              "priority": {
                "enum": [
                  "high",
                  "medium",
                  "low"
                ]
              },
              "tags": {
                "anyOf": [
                  {
                    "type": "array",
                    "items": {
                      "type": "string"
                    }
                  }
                ]
              },
              "startAt": {
                "anyOf": [
                  {
                    "type": "null"
                  },
                  {
                    "type": "string"
                  }
                ]
              },
              "endAt": {
                "anyOf": [
                  {
                    "type": "null"
                  },
                  {
                    "type": "string"
                  }
                ]
              },
              "dueDate": {
                "anyOf": [
                  {
                    "type": "null"
                  },
                  {
                    "type": "string"
                  }
                ]
              },
              "sourceUrl": {
                "anyOf": [
                  {
                    "type": "string"
                  }
                ]
              }
            },
            "required": [
              "sourceKey",
              "title"
            ],
            "additionalProperties": false
          }
        },
        "category": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "key": {
                  "type": "string"
                },
                "title": {
                  "type": "string"
                },
                "color": {
                  "anyOf": [
                    {
                      "type": "string"
                    }
                  ]
                }
              },
              "required": [
                "key",
                "title"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "toolId",
        "items"
      ],
      "additionalProperties": false
    }
  ],
  "publish_tool_follow_sources": [
    {
      "type": "object",
      "properties": {
        "toolId": {
          "type": "number"
        },
        "snapshot": {
          "type": "object",
          "properties": {
            "schemaVersion": {
              "type": "number"
            },
            "revision": {
              "type": "number"
            },
            "groups": {
              "anyOf": [
                {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "key": {
                        "type": "string"
                      },
                      "title": {
                        "type": "string"
                      }
                    },
                    "required": [
                      "key",
                      "title"
                    ],
                    "additionalProperties": false
                  }
                }
              ]
            },
            "items": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "groupKeys": {
                    "anyOf": [
                      {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      }
                    ]
                  },
                  "sourceStatus": {
                    "enum": [
                      "cancelled",
                      "scheduled",
                      "postponed",
                      "finished"
                    ]
                  },
                  "sourceKey": {
                    "type": "string"
                  },
                  "title": {
                    "type": "string"
                  },
                  "notes": {
                    "anyOf": [
                      {
                        "type": "string"
                      }
                    ]
                  },
                  "priority": {
                    "enum": [
                      "high",
                      "medium",
                      "low"
                    ]
                  },
                  "tags": {
                    "anyOf": [
                      {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      }
                    ]
                  },
                  "startAt": {
                    "anyOf": [
                      {
                        "type": "null"
                      },
                      {
                        "type": "string"
                      }
                    ]
                  },
                  "endAt": {
                    "anyOf": [
                      {
                        "type": "null"
                      },
                      {
                        "type": "string"
                      }
                    ]
                  },
                  "dueDate": {
                    "anyOf": [
                      {
                        "type": "null"
                      },
                      {
                        "type": "string"
                      }
                    ]
                  },
                  "sourceUrl": {
                    "anyOf": [
                      {
                        "type": "string"
                      }
                    ]
                  }
                },
                "required": [
                  "sourceKey",
                  "title"
                ],
                "additionalProperties": false
              }
            },
            "category": {
              "anyOf": [
                {
                  "type": "object",
                  "properties": {
                    "key": {
                      "type": "string"
                    },
                    "title": {
                      "type": "string"
                    },
                    "color": {
                      "anyOf": [
                        {
                          "type": "string"
                        }
                      ]
                    }
                  },
                  "required": [
                    "key",
                    "title"
                  ],
                  "additionalProperties": false
                }
              ]
            }
          },
          "required": [
            "schemaVersion",
            "revision",
            "items"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "toolId",
        "snapshot"
      ],
      "additionalProperties": false
    }
  ],
  "follow_tool_scope": [
    {
      "type": "object",
      "properties": {
        "toolId": {
          "type": "number"
        },
        "scope": {
          "type": "object",
          "properties": {
            "kind": {
              "enum": [
                "item",
                "group"
              ]
            },
            "key": {
              "type": "string"
            }
          },
          "required": [
            "kind",
            "key"
          ],
          "additionalProperties": false
        },
        "expectedRevision": {
          "type": "number"
        }
      },
      "required": [
        "toolId",
        "scope",
        "expectedRevision"
      ],
      "additionalProperties": false
    }
  ],
  "unfollow_tool_scope": [
    {
      "type": "object",
      "properties": {
        "toolId": {
          "type": "number"
        },
        "scope": {
          "type": "object",
          "properties": {
            "kind": {
              "enum": [
                "item",
                "group"
              ]
            },
            "key": {
              "type": "string"
            }
          },
          "required": [
            "kind",
            "key"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "toolId",
        "scope"
      ],
      "additionalProperties": false
    }
  ],
  "resume_tool_todo_following": [
    {
      "type": "object",
      "properties": {
        "todoId": {
          "type": "number"
        },
        "expectedSourceRevision": {
          "type": "number"
        },
        "expectedTodoRevision": {
          "type": "number"
        }
      },
      "required": [
        "todoId",
        "expectedSourceRevision",
        "expectedTodoRevision"
      ],
      "additionalProperties": false
    }
  ],
  "stop_tool_todo_following": [
    {
      "type": "object",
      "properties": {
        "todoId": {
          "type": "number"
        }
      },
      "required": [
        "todoId"
      ],
      "additionalProperties": false
    }
  ],
  "set_display_timezone": [
    {
      "type": "string"
    }
  ],
  "set_calendar_collection_visibility": [
    {
      "type": "object",
      "properties": {
        "collectionId": {
          "type": "string"
        },
        "visible": {
          "enum": [
            false,
            true
          ]
        }
      },
      "required": [
        "collectionId",
        "visible"
      ],
      "additionalProperties": false
    }
  ],
  "update_calendar_collection": [
    {
      "type": "object",
      "properties": {
        "collectionId": {
          "type": "string"
        },
        "expectedTitle": {
          "type": "string"
        },
        "expectedColor": {
          "type": "string"
        },
        "title": {
          "type": "string"
        },
        "color": {
          "type": "string"
        }
      },
      "required": [
        "collectionId",
        "expectedTitle",
        "expectedColor",
        "title",
        "color"
      ],
      "additionalProperties": false
    }
  ],
  "delete_calendar_collection": [
    {
      "type": "object",
      "properties": {
        "collectionId": {
          "type": "string"
        },
        "expectedTitle": {
          "type": "string"
        }
      },
      "required": [
        "collectionId",
        "expectedTitle"
      ],
      "additionalProperties": false
    }
  ],
  "import_external_events": [
    {
      "type": "object",
      "properties": {
        "providerId": {
          "type": "string"
        },
        "batchId": {
          "type": "string"
        },
        "expectedProviderRevision": {
          "type": "number"
        },
        "events": {
          "type": "array",
          "items": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "timeKind": {
                    "const": "timed"
                  },
                  "startAt": {
                    "type": "string"
                  },
                  "endAt": {
                    "anyOf": [
                      {
                        "type": "null"
                      },
                      {
                        "type": "string"
                      }
                    ]
                  },
                  "startDate": {
                    "type": "null"
                  },
                  "endDateExclusive": {
                    "type": "null"
                  },
                  "externalId": {
                    "type": "string"
                  },
                  "title": {
                    "type": "string"
                  },
                  "status": {
                    "enum": [
                      "cancelled",
                      "scheduled",
                      "postponed",
                      "finished"
                    ]
                  },
                  "sourceUrl": {
                    "type": "string"
                  },
                  "sourceTimezone": {
                    "anyOf": [
                      {
                        "type": "null"
                      },
                      {
                        "type": "string"
                      }
                    ]
                  },
                  "payload": {
                    "type": "object",
                    "properties": {},
                    "required": [],
                    "additionalProperties": {
                      "anyOf": [
                        {
                          "type": "null"
                        },
                        {
                          "type": "string"
                        },
                        {
                          "type": "number"
                        },
                        {
                          "type": "boolean"
                        },
                        {
                          "type": "boolean"
                        },
                        {
                          "type": "array",
                          "items": {
                            "anyOf": [
                              {},
                              {},
                              {},
                              {},
                              {},
                              {},
                              {}
                            ]
                          }
                        },
                        {
                          "type": "object",
                          "properties": {},
                          "required": [],
                          "additionalProperties": {
                            "anyOf": [
                              {},
                              {},
                              {},
                              {},
                              {},
                              {},
                              {}
                            ]
                          }
                        }
                      ]
                    }
                  }
                },
                "required": [
                  "timeKind",
                  "startAt",
                  "endAt",
                  "startDate",
                  "endDateExclusive",
                  "externalId",
                  "title",
                  "status",
                  "sourceUrl",
                  "payload"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "timeKind": {
                    "const": "all_day"
                  },
                  "startAt": {
                    "type": "null"
                  },
                  "endAt": {
                    "type": "null"
                  },
                  "startDate": {
                    "type": "string"
                  },
                  "endDateExclusive": {
                    "type": "string"
                  },
                  "externalId": {
                    "type": "string"
                  },
                  "title": {
                    "type": "string"
                  },
                  "status": {
                    "enum": [
                      "cancelled",
                      "scheduled",
                      "postponed",
                      "finished"
                    ]
                  },
                  "sourceUrl": {
                    "type": "string"
                  },
                  "sourceTimezone": {
                    "anyOf": [
                      {
                        "type": "null"
                      },
                      {
                        "type": "string"
                      }
                    ]
                  },
                  "payload": {
                    "type": "object",
                    "properties": {},
                    "required": [],
                    "additionalProperties": {
                      "anyOf": [
                        {
                          "type": "null"
                        },
                        {
                          "type": "string"
                        },
                        {
                          "type": "number"
                        },
                        {
                          "type": "boolean"
                        },
                        {
                          "type": "boolean"
                        },
                        {
                          "type": "array",
                          "items": {
                            "anyOf": [
                              {},
                              {},
                              {},
                              {},
                              {},
                              {},
                              {}
                            ]
                          }
                        },
                        {
                          "type": "object",
                          "properties": {},
                          "required": [],
                          "additionalProperties": {
                            "anyOf": [
                              {},
                              {},
                              {},
                              {},
                              {},
                              {},
                              {}
                            ]
                          }
                        }
                      ]
                    }
                  }
                },
                "required": [
                  "timeKind",
                  "startAt",
                  "endAt",
                  "startDate",
                  "endDateExclusive",
                  "externalId",
                  "title",
                  "status",
                  "sourceUrl",
                  "payload"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "timeKind": {
                    "const": "tbd"
                  },
                  "startAt": {
                    "type": "null"
                  },
                  "endAt": {
                    "type": "null"
                  },
                  "startDate": {
                    "type": "null"
                  },
                  "endDateExclusive": {
                    "type": "null"
                  },
                  "externalId": {
                    "type": "string"
                  },
                  "title": {
                    "type": "string"
                  },
                  "status": {
                    "enum": [
                      "cancelled",
                      "scheduled",
                      "postponed",
                      "finished"
                    ]
                  },
                  "sourceUrl": {
                    "type": "string"
                  },
                  "sourceTimezone": {
                    "anyOf": [
                      {
                        "type": "null"
                      },
                      {
                        "type": "string"
                      }
                    ]
                  },
                  "payload": {
                    "type": "object",
                    "properties": {},
                    "required": [],
                    "additionalProperties": {
                      "anyOf": [
                        {
                          "type": "null"
                        },
                        {
                          "type": "string"
                        },
                        {
                          "type": "number"
                        },
                        {
                          "type": "boolean"
                        },
                        {
                          "type": "boolean"
                        },
                        {
                          "type": "array",
                          "items": {
                            "anyOf": [
                              {},
                              {},
                              {},
                              {},
                              {},
                              {},
                              {}
                            ]
                          }
                        },
                        {
                          "type": "object",
                          "properties": {},
                          "required": [],
                          "additionalProperties": {
                            "anyOf": [
                              {},
                              {},
                              {},
                              {},
                              {},
                              {},
                              {}
                            ]
                          }
                        }
                      ]
                    }
                  }
                },
                "required": [
                  "timeKind",
                  "startAt",
                  "endAt",
                  "startDate",
                  "endDateExclusive",
                  "externalId",
                  "title",
                  "status",
                  "sourceUrl",
                  "payload"
                ],
                "additionalProperties": false
              }
            ]
          }
        }
      },
      "required": [
        "providerId",
        "batchId",
        "expectedProviderRevision",
        "events"
      ],
      "additionalProperties": false
    }
  ],
  "archive_external_event": [
    {
      "type": "object",
      "properties": {
        "eventId": {
          "type": "string"
        }
      },
      "required": [
        "eventId"
      ],
      "additionalProperties": false
    }
  ],
  "delete_unused_external_event": [
    {
      "type": "object",
      "properties": {
        "eventId": {
          "type": "string"
        }
      },
      "required": [
        "eventId"
      ],
      "additionalProperties": false
    }
  ],
  "update_event_provider": [
    {
      "type": "object",
      "properties": {
        "providerId": {
          "type": "string"
        },
        "expectedRevision": {
          "type": "number"
        },
        "enabled": {
          "enum": [
            false,
            true
          ]
        }
      },
      "required": [
        "providerId",
        "expectedRevision",
        "enabled"
      ],
      "additionalProperties": false
    }
  ],
  "subscribe_event": [
    {
      "type": "object",
      "properties": {
        "eventId": {
          "type": "string"
        }
      },
      "required": [
        "eventId"
      ],
      "additionalProperties": false
    }
  ],
  "unsubscribe_event": [
    {
      "type": "object",
      "properties": {
        "todoPolicy": {
          "enum": [
            "keep",
            "delete_open"
          ]
        },
        "expectedTodoRevision": {
          "anyOf": [
            {
              "type": "number"
            }
          ]
        },
        "eventId": {
          "type": "string"
        }
      },
      "required": [
        "todoPolicy",
        "eventId"
      ],
      "additionalProperties": false
    }
  ],
  "resume_event_following": [
    {
      "type": "object",
      "properties": {
        "expectedEventRevision": {
          "type": "number"
        },
        "expectedTodoRevision": {
          "type": "number"
        },
        "eventId": {
          "type": "string"
        }
      },
      "required": [
        "expectedEventRevision",
        "expectedTodoRevision",
        "eventId"
      ],
      "additionalProperties": false
    }
  ],
  "install_extension": [
    {
      "type": "object",
      "properties": {
        "stagingDirectory": {
          "type": "string"
        },
        "expectedExtensionRevision": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "number"
            }
          ]
        },
        "expectedPackageDigest": {
          "type": "string"
        },
        "authorizationRef": {
          "type": "string"
        }
      },
      "required": [
        "stagingDirectory",
        "expectedExtensionRevision",
        "expectedPackageDigest",
        "authorizationRef"
      ],
      "additionalProperties": false
    }
  ],
  "authorize_extension_install": [
    {
      "type": "object",
      "properties": {
        "stagingDirectory": {
          "type": "string"
        },
        "expectedPackageDigest": {
          "type": "string"
        },
        "expectedExtensionRevision": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "number"
            }
          ]
        }
      },
      "required": [
        "stagingDirectory",
        "expectedPackageDigest",
        "expectedExtensionRevision"
      ],
      "additionalProperties": false
    }
  ],
  "set_extension_enabled": [
    {
      "type": "object",
      "properties": {
        "enabled": {
          "enum": [
            false,
            true
          ]
        },
        "extensionId": {
          "type": "string"
        },
        "expectedRevision": {
          "type": "number"
        }
      },
      "required": [
        "enabled",
        "extensionId",
        "expectedRevision"
      ],
      "additionalProperties": false
    }
  ],
  "uninstall_extension": [
    {
      "type": "object",
      "properties": {
        "extensionId": {
          "type": "string"
        },
        "expectedRevision": {
          "type": "number"
        }
      },
      "required": [
        "extensionId",
        "expectedRevision"
      ],
      "additionalProperties": false
    }
  ],
  "rollback_extension": [
    {
      "type": "object",
      "properties": {
        "version": {
          "type": "string"
        },
        "authorizationRef": {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        },
        "extensionId": {
          "type": "string"
        },
        "expectedRevision": {
          "type": "number"
        }
      },
      "required": [
        "version",
        "extensionId",
        "expectedRevision"
      ],
      "additionalProperties": false
    }
  ],
  "refresh_event_provider": [
    {
      "type": "object",
      "properties": {
        "providerId": {
          "type": "string"
        }
      },
      "required": [
        "providerId"
      ],
      "additionalProperties": false
    }
  ]
};
