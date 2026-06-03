package query

import (
	"reflect"
	"sort"
	"testing"
)

// pruneToMostConnected keeps the top-N nodes by total edge weight
// (in-degree + out-degree, summed by edge count). These tests cover the
// boundary behaviors that matter when the UI is rendering the Flow Map:
//   - exactly N keeps everyone
//   - more-than-N drops the least-connected
//   - ties don't crash
//   - empty input doesn't crash
func TestPruneToMostConnected(t *testing.T) {
	tests := []struct {
		name  string
		edges []GraphEdge
		limit int
		want  []string // expected node IDs (order-independent)
	}{
		{
			name:  "empty edges → empty set",
			edges: nil,
			limit: 10,
			want:  []string{},
		},
		{
			name: "fewer nodes than limit → keep all",
			edges: []GraphEdge{
				{From: "a", To: "b", Count: 5},
				{From: "b", To: "c", Count: 3},
			},
			limit: 10,
			want:  []string{"a", "b", "c"},
		},
		{
			name: "exactly N nodes → keep all",
			edges: []GraphEdge{
				{From: "a", To: "b", Count: 5},
				{From: "b", To: "c", Count: 3},
			},
			limit: 3,
			want:  []string{"a", "b", "c"},
		},
		{
			name: "more nodes than limit → keep most-connected",
			// Weights: a=10 (out 10), b=13 (in 10 + out 3), c=8 (in 3 + out 5), d=5 (in 5)
			// limit=2 → keep b, a (top two weights)
			edges: []GraphEdge{
				{From: "a", To: "b", Count: 10},
				{From: "b", To: "c", Count: 3},
				{From: "c", To: "d", Count: 5},
			},
			limit: 2,
			want:  []string{"a", "b"},
		},
		{
			name: "self-loop counts in-and-out for the same node",
			// a: self-loop count=5 → weight=10. b: in=2 → weight=2.
			edges: []GraphEdge{
				{From: "a", To: "a", Count: 5},
				{From: "a", To: "b", Count: 2},
			},
			limit: 1,
			want:  []string{"a"},
		},
		{
			name: "limit zero → empty",
			edges: []GraphEdge{
				{From: "a", To: "b", Count: 1},
			},
			limit: 0,
			want:  []string{},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := pruneToMostConnected(tt.edges, tt.limit)
			gotIDs := make([]string, 0, len(got))
			for id := range got {
				gotIDs = append(gotIDs, id)
			}
			sort.Strings(gotIDs)
			sort.Strings(tt.want)
			if !reflect.DeepEqual(gotIDs, tt.want) {
				t.Errorf("got %v, want %v", gotIDs, tt.want)
			}
		})
	}
}
